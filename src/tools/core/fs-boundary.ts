/**
 * Shared filesystem-tool boundary: a containment check (allowed roots +
 * always-denied secret paths) plus the Windows reserved-name guard. Used by
 * filesystem.ts (read/write/edit/list/glob/grep) and attach_local_file so
 * every host-touching tool resolves and contains paths the same way.
 *
 * Threat model: this is defense-in-depth against PROMPT INJECTION — a
 * malicious web page or tool result coaxing the agent into reading
 * `.mantle/config.json` (API keys) or `~/.ssh` and exfiltrating it. It is NOT
 * a sandbox: the `bash` tool is a full shell and can still reach anything the
 * mantle process can. The auth wall is the primary control; this narrows the
 * tool-only attack surface.
 *
 * The boundary is a module-level singleton set once at boot (see
 * src/index.ts). Until set, containment is OFF — so tools registered outside
 * the normal boot path (tests, scripts) keep their legacy unrestricted
 * behavior and only the live server enforces it.
 */

import { resolve, relative, isAbsolute, dirname, basename } from "path";
import { existsSync, realpathSync } from "fs";

let _allowedRoots: string[] | null = null;
let _deniedPaths: string[] = [];

// Resolve a path to its real on-disk identity before the containment check.
// A lexical `resolve()` alone is contained BY NAME but a symlink or NTFS
// junction inside an allowed root that points outside it is followed by the
// OS on open (junctions need no admin to create) — so the check must run on
// what the OS will actually open. For not-yet-existing targets (write_file
// to a new path) we realpath the nearest existing ancestor and re-append the
// non-existent tail. realpath failure (permissions, races) falls back to the
// lexical path — same behavior as before this hardening, never worse.
function canonicalize(p: string): string {
  let existing = p;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break; // reached the filesystem root
    tail.unshift(basename(existing));
    existing = parent;
  }
  try {
    existing = realpathSync.native(existing);
  } catch {
    // keep the lexical form — containment still applies to it
  }
  return tail.length > 0 ? resolve(existing, ...tail) : existing;
}

export function setFilesystemBoundary(opts: {
  allowedRoots: string[];
  deniedPaths: string[];
}): void {
  // Canonicalize the boundary itself too — if basePath lives behind a
  // junction (Dropbox/OneDrive-style relocations), the roots must compare in
  // the same canonical space as the canonicalized target paths.
  _allowedRoots = opts.allowedRoots.map((r) => canonicalize(resolve(r)));
  _deniedPaths = opts.deniedPaths.map((p) => canonicalize(resolve(p)));
}

/** Test/utility hook — reverts to the unconfigured (no-containment) state. */
export function clearFilesystemBoundary(): void {
  _allowedRoots = null;
  _deniedPaths = [];
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Returns an error message if `resolvedPath` falls inside a denied path or
 * outside every allowed root; null if it's permitted. No-ops (returns null)
 * when the boundary hasn't been configured.
 *
 * Two Windows path-identity tricks are rejected up front, because they make
 * a path open something other than what the string compare sees:
 *   - NTFS alternate data streams: `config.json::$DATA` / `file:stream`
 *     opens the same file's stream, but no deny-list string matches it.
 *   - Trailing dots/spaces: the Win32 layer strips them on open, so
 *     `config.json.` IS `config.json` to the OS but not to a compare.
 * After that, the path is canonicalized (realpath) so symlinks/junctions
 * are contained by what they POINT AT, not by their name.
 */
export function containmentError(resolvedPath: string, given: string): string | null {
  if (_allowedRoots === null) return null; // boundary not configured (tests/scripts)

  if (process.platform === "win32") {
    // Any ":" past the drive-letter colon denotes an ADS (or an illegal name).
    if (resolvedPath.replace(/^[a-zA-Z]:/, "").includes(":")) {
      return `Path "${given}" is blocked — NTFS alternate data stream syntax (":") is not allowed in filesystem tools.`;
    }
    // A segment ending in "." or " " opens a different name than it compares as.
    if (/[. ](?=[\\/]|$)/.test(resolvedPath)) {
      return `Path "${given}" is blocked — path segments ending in a dot or space are not allowed on Windows (the OS silently strips them on open).`;
    }
  }

  const canonical = canonicalize(resolvedPath);

  for (const denied of _deniedPaths) {
    if (isWithin(denied, canonical)) {
      return `Path "${given}" is blocked — it resolves inside ${denied}, which holds mantle's secrets and is off-limits to filesystem tools.`;
    }
  }

  if (_allowedRoots.length === 0) return null; // empty allowlist = allow all (deny-list still applies)
  for (const root of _allowedRoots) {
    if (isWithin(root, canonical)) return null;
  }
  return `Path "${given}" (resolved to ${canonical}) is outside the allowed filesystem roots: ${_allowedRoots.join(", ")}. To widen access, add a root to tools.filesystem.allowedRoots in config.`;
}

// ── Windows reserved device names ─────────────────────────────────────────
// These resolve to a device when OPENED, but `mkdirSync` calls
// CreateDirectoryW directly, which does NOT reject the name — so
// write_file("nul/x.txt") creates a real `nul/` directory (which then
// confuses git, since git routes `nul` to the null device) and silently
// writes nothing inside. Guard all filesystem tools up front on win32 so an
// LLM-hallucinated "nul" in a path can't leave a phantom folder behind.
const WINDOWS_RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

export function checkReservedWindowsName(given: string): string | null {
  if (process.platform !== "win32") return null;
  for (const seg of given.split(/[\\/]+/)) {
    if (!seg) continue;
    // Windows treats `nul.txt`, `nul.anything` as the same device (extension
    // is ignored for device-name resolution).
    const stem = seg.split(".")[0].toLowerCase();
    if (WINDOWS_RESERVED_NAMES.has(stem)) {
      return `Path "${given}" contains Windows reserved device name "${seg}". Rejected to prevent a phantom directory. Reserved: nul, con, prn, aux, com1–9, lpt1–9.`;
    }
  }
  return null;
}
