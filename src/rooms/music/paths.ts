import { resolve, join, sep } from "path";
import { existsSync } from "fs";

// Path helpers shared by the music manager (downloads) and the /api/music REST
// layer (tray scan, stream, folder CRUD, move). All user/agent-supplied path
// segments funnel through here so nothing can escape .mantle/music.
//
// Sanitizers use an allowlist (letters, digits, dot, underscore, space, dash),
// then collapse whitespace to underscores — so path segments never contain
// spaces (keeps URL building trivial) and Windows-illegal chars (< > : " / \
// | ? *), control chars, emoji, etc. are all dropped.

const ALLOWED = /[^\p{L}\p{N}._ -]+/gu;

// Sanitize a single path segment used as a directory name — the per-agent
// bucket or a user-created folder.
export function sanitizeSegment(name: string): string {
  let s = (name || "").normalize("NFC").trim().replace(ALLOWED, "");
  s = s.replace(/\s+/g, "_").replace(/^[.]+/, "");
  s = s.slice(0, 64).replace(/[._-]+$/, "");
  return s || "misc";
}

// Sanitize a track file base name (no extension); same rules, shorter cap.
export function sanitizeFilename(name: string): string {
  let s = (name || "").normalize("NFC").trim().replace(ALLOWED, "");
  s = s.replace(/\s+/g, "_").replace(/^[.]+/, "");
  s = s.slice(0, 60).replace(/[._-]+$/, "");
  return s || "track";
}

// Resolve an agent/user-supplied relative path UNDER `root` and confirm it
// can't climb out (traversal guard). Returns the absolute path, or null if it
// would escape. `rel` may span the agent bucket + nested folders + filename.
export function resolveUnder(root: string, rel: string): string | null {
  const rootResolved = resolve(root);
  const abs = resolve(rootResolved, rel);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) return null;
  return abs;
}

// First free `<base><ext>`, then `<base>_1<ext>`, ... in `dir`.
export function uniquePath(dir: string, base: string, ext: string): string {
  let candidate = join(dir, `${base}${ext}`);
  let n = 1;
  while (existsSync(candidate)) {
    candidate = join(dir, `${base}_${n}${ext}`);
    n++;
  }
  return candidate;
}
