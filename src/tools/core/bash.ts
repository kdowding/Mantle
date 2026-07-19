import type { Tool } from "../types.js";
import { existsSync } from "fs";
import { platform } from "os";

const MAX_OUTPUT_SIZE = 100_000; // 100KB
const DEFAULT_TIMEOUT = 30_000;  // 30 seconds

// PATH lookup of `bash` on Windows often resolves to
// C:\Windows\System32\bash.exe — the WSL launcher. On a machine without
// a working WSL distro that dies with:
//   WSL (13) ERROR: CreateProcessCommon:559: execvpe(/bin/bash) failed:
//     No such file or directory
// Pick a real Win32 bash (Git Bash / MSYS / Cygwin) instead. Override
// with MANTLE_BASH_PATH if the install lives somewhere unusual.
function resolveBashBinary(): string {
  if (platform() !== "win32") return "bash";

  const override = process.env.MANTLE_BASH_PATH;
  if (override && existsSync(override)) return override;

  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "C:\\msys64\\usr\\bin\\bash.exe",
    "C:\\cygwin64\\bin\\bash.exe",
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  // Last resort — let PATH decide and surface whatever error follows.
  return "bash";
}

const BASH_BINARY = resolveBashBinary();

// Build the env we hand to spawned bash processes once at module load.
// The previous behavior — appending POSIX-flavored paths to whatever was
// in process.env.PATH using a `:` separator — corrupted the PATH inside
// git-bash on Windows: the resulting string mixed `;` (Windows) and `:`
// (POSIX) separators, MSYS2's PATH parser split on `:` and treated `C`
// as a directory, dropping `usr\bin` from the search and breaking even
// `ls`/`cat`/`grep`. The fix on Windows is to PREPEND the resolved
// bash's bundled coreutils dirs in Windows-native form (`;` separator,
// `C:\` paths) — git-bash's MSYS2 runtime translates them on entry.
// On POSIX we just inherit the parent env unchanged; the prior code's
// hardcoded `/c/Program Files/nodejs` and `~/AppData/Roaming/npm`
// additions were Windows-flavored and meaningless there.
function buildBashEnv(bashBinary: string): Record<string, string | undefined> {
  if (platform() !== "win32") return process.env;

  const m = bashBinary.match(/^(.+?)[\\/](?:usr[\\/]bin|bin)[\\/]bash\.exe$/i);
  if (!m) return process.env;
  const root = m[1];

  // Try every layout we know about; existsSync filters to the ones the
  // user's actually-installed shell ships. Git Bash → usr\bin + mingw64\bin;
  // MSYS2 → same; Cygwin → bin (root\bin).
  const utilDirs = [
    `${root}\\usr\\bin`,
    `${root}\\mingw64\\bin`,
    `${root}\\mingw32\\bin`,
    `${root}\\bin`,
  ].filter((p) => existsSync(p));
  if (!utilDirs.length) return process.env;

  return {
    ...process.env,
    PATH: `${process.env.PATH ?? ""};${utilDirs.join(";")}`,
  };
}

const BASH_ENV = buildBashEnv(BASH_BINARY);

export function createBashTool(): Tool {
  console.log(`[MANTLE]   bash tool using: ${BASH_BINARY}`);
  return {
    name: "bash",
    description: [
      "Execute a shell command and return its output. Both stdout and stderr stream live to the UI as the command runs — long-running commands like `npm install` or build scripts show progress in real time, no polling needed.",
      "Runs from your agent workspace; relative paths in commands resolve against it. On Windows the bash binary is Git Bash, so POSIX commands (`ls`, `cat`, `grep`, `find`, `git`, `node`, `python`) work, but `apt`/`brew` do not — use direct downloads or skip platform-specific package managers.",
      "Default timeout is 30s; pass `timeout` (ms) to override. /stop kills the process immediately via SIGKILL. Output is capped at 100KB; longer outputs get truncated with a marker.",
      "Examples: `git status`, `npm test`, `ls -la src`, `bun x tsc --noEmit`.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        timeout: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
      },
      required: ["command"],
    },
    async execute(input, context) {
      const command = String(input.command);
      const timeout = Number(input.timeout ?? DEFAULT_TIMEOUT);
      const progress = context?.progress;
      const signal = context?.signal;

      // Bail early if the user already aborted before we got here (e.g.
      // /stop fired between provider stream end and tool dispatch).
      if (signal?.aborted) {
        return { content: "Aborted before command started", isError: true };
      }

      // H7 gate: optionally forbid bash in autonomous (scheduled) runs entirely.
      // Off by default — the cron presets already exclude bash from the safe
      // surface; set MANTLE_CRON_NO_BASH=1 for a belt-and-suspenders global ban.
      if (context?.autonomous && process.env.MANTLE_CRON_NO_BASH === "1") {
        return { content: "bash is disabled for autonomous (scheduled) runs on this install (MANTLE_CRON_NO_BASH=1).", isError: true };
      }

      let killedByAbort = false;
      let killedByTimeout = false;

      try {
        const proc = Bun.spawn([BASH_BINARY, "-c", command], {
          // Resolve cwd against the calling agent's workspace so `ls` /
          // `pwd` / relative paths land where AGENTS.md says they should
          // ("Workspace root: this directory. Use relative paths."). Falls
          // back to mantle's cwd when invoked outside an agent context
          // (tests, boot-time tooling).
          cwd: context?.workspacePath ?? process.cwd(),
          stdout: "pipe",
          stderr: "pipe",
          env: BASH_ENV,
        });

        const timer = setTimeout(() => {
          killedByTimeout = true;
          try { proc.kill(); } catch { /* already dead */ }
        }, timeout);

        // Wire abort → SIGKILL so /stop terminates the child immediately
        // instead of waiting for natural completion. Without this, the
        // loop's iteration-boundary signal check only fires after the
        // tool returns, so a 30s `sleep` ignored /stop entirely.
        const onAbort = () => {
          killedByAbort = true;
          try { proc.kill(); } catch { /* already dead */ }
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        // Stream stdout + stderr concurrently, calling progress() per
        // chunk so the UI sees output land in real time instead of a
        // dump on tool completion. We still aggregate into a string for
        // the final ToolResult — the model sees the full output as
        // before; the streaming is a UI-only courtesy.
        const [stdout, stderr] = await Promise.all([
          collectStream(proc.stdout, (chunk) => progress?.({ chunk, stream: "stdout" })),
          collectStream(proc.stderr, (chunk) => progress?.({ chunk, stream: "stderr" })),
        ]);
        const exitCode = await proc.exited;

        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);

        if (killedByAbort) {
          return { content: "Aborted by user (/stop)", isError: true };
        }
        if (killedByTimeout) {
          return {
            content: `Command timed out after ${timeout}ms\n\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.slice(0, MAX_OUTPUT_SIZE),
            isError: true,
          };
        }

        let output = "";
        if (stdout) output += stdout;
        if (stderr) output += (output ? "\n" : "") + `[stderr]\n${stderr}`;

        // Truncate if too large
        if (output.length > MAX_OUTPUT_SIZE) {
          output = output.slice(0, MAX_OUTPUT_SIZE) + `\n\n[Output truncated at ${MAX_OUTPUT_SIZE} bytes]`;
        }

        if (!output.trim()) {
          output = `(no output, exit code: ${exitCode})`;
        } else if (exitCode !== 0) {
          output = `Exit code: ${exitCode}\n\n${output}`;
        }

        return { content: output, isError: exitCode !== 0 };
      } catch (err) {
        return { content: `Error executing command: ${err}`, isError: true };
      }
    },
  };
}

// Drain a Bun child stream (ReadableStream<Uint8Array>) into a string,
// firing onChunk for each decoded slice as it arrives. Decoder is
// stream-mode so multi-byte chars split across chunk boundaries don't
// produce mojibake. Final decode() flushes any tail bytes.
async function collectStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let collected = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) {
        collected += text;
        try { onChunk(text); } catch { /* progress callback errors don't kill the read */ }
      }
    }
    const tail = decoder.decode();
    if (tail) {
      collected += tail;
      try { onChunk(tail); } catch { /* same */ }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* noop */ }
  }
  return collected;
}
