import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve, join } from "path";
import { isUiStale } from "./ui-build.js";

// A throwaway repo skeleton with the inputs isUiStale reads. All mtimes are set
// explicitly per test (never wall-clock) so the comparisons are deterministic.
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "mantle-uib-"));
  mkdirSync(resolve(root, "ui", "dist"), { recursive: true });
  mkdirSync(resolve(root, "ui", "src"), { recursive: true });
  writeFileSync(resolve(root, "ui", "dist", "index.html"), "<html></html>");
  writeFileSync(resolve(root, "ui", "index.html"), "<html></html>");
  writeFileSync(resolve(root, "ui", "vite.config.ts"), "export default {}");
  writeFileSync(resolve(root, "ui", "src", "App.svelte"), "x");
  return root;
}

// Stamp every input (source tree + build output) to the same epoch-second time.
function setTree(root: string, t: number): void {
  for (const p of [
    "ui/src/App.svelte",
    "ui/src",
    "ui/index.html",
    "ui/vite.config.ts",
    "ui/dist/index.html",
  ]) {
    utimesSync(resolve(root, p), t, t);
  }
}

test("not stale when dist is newer than every source input", () => {
  const root = makeRepo();
  try {
    setTree(root, 1000);
    utimesSync(resolve(root, "ui/dist/index.html"), 2000, 2000);
    expect(isUiStale(root)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale when a source file was edited after the last build", () => {
  const root = makeRepo();
  try {
    setTree(root, 2000); // build + source all aligned...
    utimesSync(resolve(root, "ui/src/App.svelte"), 3000, 3000); // ...then a file edit
    expect(isUiStale(root)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale when ui/dist/index.html is missing (never built)", () => {
  const root = makeRepo();
  try {
    rmSync(resolve(root, "ui/dist/index.html"));
    expect(isUiStale(root)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
