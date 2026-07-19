// Download / verify / extract substrate shared by both provisioners.
//
// downloadVerified mirrors src/local/pull.ts's downloadFile (stream to a `.part`
// sibling, content-length guard, rename on success) and adds streaming SHA256
// verification against the GitHub-published per-asset digest — we never rename a
// binary into place unless its bytes match. extractArchive shells out to a
// libarchive-class `tar` (bsdtar ships in System32 on Win10 1803+ and reads BOTH
// .zip and .tar.gz; `tar -xzf` covers macOS/Linux). runCommand streams a
// subprocess's output line-by-line for the voice install steps.

import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "fs";
import { basename, join } from "path";

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number;
  speedBytesPerSec: number;
}

/**
 * Stream `url` to `dest`, verifying SHA256 if `sha256` is given (accepts a bare
 * hex digest or a `sha256:`-prefixed one, as the GitHub asset `digest` field
 * carries). Streams into `<dest>.part` and renames only on a complete +
 * checksum-valid transfer, so a torn or tampered download never lands at the
 * final path. Throws (cleaning up the partial) on any failure.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  opts: { sha256?: string; headers?: Record<string, string>; signal?: AbortSignal } = {},
  onProgress?: (p: DownloadProgress) => void,
): Promise<number> {
  const resp = await fetch(url, { headers: opts.headers, redirect: "follow", signal: opts.signal });
  if (!resp.ok || !resp.body) {
    throw new Error(`Download failed (${resp.status} ${resp.statusText}) for ${url}`);
  }
  const total = Number(resp.headers.get("content-length") || 0);
  const partPath = `${dest}.part`;
  const sink = Bun.file(partPath).writer();
  const reader = resp.body.getReader();
  const hasher = opts.sha256 ? new Bun.CryptoHasher("sha256") : null;
  let received = 0;
  let sinceFlush = 0;
  let lastCb = 0;
  const FLUSH_EVERY = 16 * 1024 * 1024;
  const start = Date.now();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sink.write(value);
      hasher?.update(value);
      received += value.length;
      sinceFlush += value.length;
      if (sinceFlush >= FLUSH_EVERY) {
        await sink.flush();
        sinceFlush = 0;
      }
      const now = Date.now();
      if (now - lastCb > 200) {
        lastCb = now;
        onProgress?.({ receivedBytes: received, totalBytes: total, speedBytesPerSec: received / ((now - start) / 1000) });
      }
    }
    await sink.end();
    if (total > 0 && received < total) {
      throw new Error(`Download incomplete (${received}/${total} bytes) for ${url}`);
    }
    if (opts.sha256 && hasher) {
      const got = hasher.digest("hex").toLowerCase();
      const want = opts.sha256.replace(/^sha256:/i, "").toLowerCase();
      if (got !== want) {
        throw new Error(
          `Checksum mismatch for ${basename(dest)} — expected ${want.slice(0, 16)}…, got ${got.slice(0, 16)}… (refusing to install)`,
        );
      }
    }
    renameSync(partPath, dest);
  } catch (err) {
    await Promise.resolve(sink.end()).catch(() => {});
    try {
      if (existsSync(partPath)) unlinkSync(partPath);
    } catch {
      /* best effort */
    }
    throw err;
  }
  return received;
}

/** Absolute path to a libarchive-class tar that can read .zip. On Windows that's
 *  System32\tar.exe (bsdtar) — pinned absolute so a git-bash GNU tar earlier on
 *  PATH (which can't read .zip) never shadows it. Elsewhere `tar` is fine. */
function tarBinary(): string {
  if (process.platform === "win32") {
    const sys = process.env.SystemRoot || "C:\\Windows";
    const bsdtar = `${sys}\\System32\\tar.exe`;
    if (existsSync(bsdtar)) return bsdtar;
  }
  return "tar";
}

/**
 * Extract a .zip or .tar.gz into `destDir` (created if absent). Uses bsdtar on
 * Windows (handles both), GNU/bsd `tar -xzf` for .tar.gz elsewhere, and `unzip`
 * for the rare non-Windows .zip. Throws with the tar/unzip stderr tail on a
 * non-zero exit.
 */
export async function extractArchive(archivePath: string, destDir: string, signal?: AbortSignal): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  const isZip = /\.zip$/i.test(archivePath);
  let cmd: string[];
  if (process.platform === "win32") {
    cmd = [tarBinary(), "-xf", archivePath, "-C", destDir];
  } else if (isZip) {
    cmd = ["unzip", "-o", archivePath, "-d", destDir];
  } else {
    cmd = ["tar", "-xzf", archivePath, "-C", destDir];
  }
  const proc = Bun.spawn({ cmd, stdout: "ignore", stderr: "pipe", signal });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) {
    throw new Error(`Extraction failed (${basename(cmd[0])} exit ${code}): ${stderr.trim().slice(0, 300)}`);
  }
}

export interface CommandResult {
  code: number;
  /** The last ~40 lines of combined output — enough context for an error
   *  message without dumping a multi-thousand-line pip log. */
  tail: string;
}

/**
 * Run a subprocess, forwarding each stdout/stderr line to `onLine` (for live
 * provision progress) and retaining a bounded tail for the error message.
 * Resolves with the exit code; never throws on a non-zero exit (the caller
 * decides what a failure means).
 */
export async function runCommand(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal; onLine?: (line: string) => void } = {},
): Promise<CommandResult> {
  const proc = Bun.spawn({
    cmd,
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: opts.signal,
  });

  const tailLines: string[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trimEnd();
          buf = buf.slice(idx + 1);
          if (line) {
            opts.onLine?.(line);
            tailLines.push(line);
            if (tailLines.length > 40) tailLines.shift();
          }
        }
      }
      if (buf.trim()) {
        opts.onLine?.(buf.trim());
        tailLines.push(buf.trim());
        if (tailLines.length > 40) tailLines.shift();
      }
    } catch {
      /* stream closed (abort / process exit) */
    }
  };

  const [code] = await Promise.all([proc.exited, pump(proc.stdout), pump(proc.stderr)]);
  return { code, tail: tailLines.join("\n") };
}

/**
 * Bounded recursive search for `filename` under `dir`. Extracted release trees
 * vary by platform packaging (binaries flat at root on Windows, nested under a
 * triple-named or build/bin/ directory elsewhere), so both provisioners locate
 * their binary by name rather than assuming a layout. Returns the first match's
 * absolute path, or null.
 */
export function findFileRecursive(dir: string, filename: string, depth = 0): string | null {
  if (depth > 6 || !existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  // Files first (a shallow match wins over a deeper one).
  for (const e of entries) {
    const full = join(dir, e);
    try {
      if (statSync(full).isFile() && e === filename) return full;
    } catch {
      /* skip unreadable entries */
    }
  }
  for (const e of entries) {
    const full = join(dir, e);
    try {
      if (statSync(full).isDirectory()) {
        const hit = findFileRecursive(full, filename, depth + 1);
        if (hit) return hit;
      }
    } catch {
      /* skip */
    }
  }
  return null;
}
