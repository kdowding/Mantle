// Build-if-stale for the Svelte UI. The Bun server serves `ui/dist` as static
// files; nothing rebuilds it automatically, so a source edit on the Vite side
// (`ui/src`) silently goes unseen until someone runs `vite build ui`. This is
// the one place that decides "is the built UI older than its source?" and, if
// so, runs the build. Shared by the foreground start script (scripts/start.ts)
// and the background lifecycle (`mantle start`) so the two can't drift.

import { existsSync, statSync, readdirSync } from "fs";
import { resolve, join } from "path";

// Source inputs whose change should trigger a rebuild, relative to repo root.
// Directories are walked recursively; files are stat'd directly. vite.config
// and index.html shape the build output as much as the source tree does.
const UI_SOURCE_DIRS = ["ui/src", "ui/public"];
const UI_SOURCE_FILES = ["ui/index.html", "ui/vite.config.ts"];

// Newest mtime (ms) at or under `path`. For a directory, walks it recursively
// so an edit to any nested file — or an add/remove that bumps a dir's own
// mtime — counts. Missing path → 0 (it simply doesn't contribute).
function newestMtime(path: string): number {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  let newest = st.mtimeMs;
  if (st.isDirectory()) {
    for (const entry of readdirSync(path, { recursive: true }) as string[]) {
      try {
        const m = statSync(join(path, entry)).mtimeMs;
        if (m > newest) newest = m;
      } catch {
        // A file vanished mid-walk (build output churn, editor temp). Ignore.
      }
    }
  }
  return newest;
}

// True when ui/dist is missing or older than any UI source input. The build
// stamp is ui/dist/index.html — Vite rewrites it on every build.
export function isUiStale(root: string): boolean {
  const distIndex = resolve(root, "ui", "dist", "index.html");
  if (!existsSync(distIndex)) return true; // never built
  const built = statSync(distIndex).mtimeMs;
  const inputs = [...UI_SOURCE_DIRS, ...UI_SOURCE_FILES].map((p) => resolve(root, p));
  return inputs.some((p) => newestMtime(p) > built);
}

// Build the UI if (and only if) it's stale. Returns true if a build ran, false
// if the existing build was already current. Throws if the build process exits
// non-zero — callers decide whether that's fatal (it usually isn't: the prior
// dist still serves). Build output streams to this process's stdout/stderr.
export async function ensureUiBuilt(
  root: string,
  log: (msg: string) => void = console.log,
): Promise<boolean> {
  if (!isUiStale(root)) {
    log("[MANTLE] UI build is up to date.");
    return false;
  }
  log("[MANTLE] UI source changed — building (vite build ui)...");
  const proc = Bun.spawn([process.execPath, "run", "ui:build"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`UI build failed (vite exited ${code})`);
  log("[MANTLE] UI build complete.");
  return true;
}
