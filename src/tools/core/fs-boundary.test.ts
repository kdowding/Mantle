// Containment-boundary tests — also wires in the declared test hooks
// (clearFilesystemBoundary here; __resetSkillCache in skills tests) that
// existed without any test using them.

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { setFilesystemBoundary, clearFilesystemBoundary, containmentError } from "./fs-boundary.js";

afterEach(() => {
  // Never leak a test boundary into other test files (module singleton).
  clearFilesystemBoundary();
});

describe("filesystem boundary", () => {
  test("unconfigured boundary allows everything (tests/scripts mode)", () => {
    clearFilesystemBoundary();
    expect(containmentError(resolve(tmpdir(), "anything.txt"), "anything.txt")).toBeNull();
  });

  test("inside allowed root passes; outside is blocked; denied wins inside", () => {
    const root = mkdtempSync(join(tmpdir(), "mantle-fsb-"));
    const denied = resolve(root, "secrets");
    mkdirSync(denied, { recursive: true });
    setFilesystemBoundary({ allowedRoots: [root], deniedPaths: [denied] });

    expect(containmentError(resolve(root, "ok.txt"), "ok.txt")).toBeNull();
    expect(containmentError(resolve(tmpdir(), "elsewhere.txt"), "elsewhere.txt")).not.toBeNull();
    expect(containmentError(resolve(denied, "users.json"), "secrets/users.json")).not.toBeNull();
  });

  test("ADS colon syntax is rejected on win32", () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(join(tmpdir(), "mantle-fsb-"));
    setFilesystemBoundary({ allowedRoots: [root], deniedPaths: [] });
    expect(containmentError(`${resolve(root, "f.txt")}:stream`, "f.txt:stream")).not.toBeNull();
  });

  test("clearFilesystemBoundary removes containment", () => {
    const root = mkdtempSync(join(tmpdir(), "mantle-fsb-"));
    setFilesystemBoundary({ allowedRoots: [root], deniedPaths: [] });
    expect(containmentError(resolve(tmpdir(), "x.txt"), "x.txt")).not.toBeNull();
    clearFilesystemBoundary();
    expect(containmentError(resolve(tmpdir(), "x.txt"), "x.txt")).toBeNull();
  });
});
