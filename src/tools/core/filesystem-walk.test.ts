import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Tool, ToolContext } from "../types.js";
import { createFilesystemTools } from "./filesystem.js";

const tools = createFilesystemTools();
const glob = tools.find((t) => t.name === "glob_files") as Tool;
const grep = tools.find((t) => t.name === "grep_files") as Tool;

let root: string;
const ctx = (): ToolContext => ({ workspacePath: root } as ToolContext);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mantle-walk-"));
  // A normal source dir with the target file...
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "MANTLE.md"), "hello mantle");
  // ...and same-named files buried in dirs that MUST be pruned. Their
  // contents also match the grep pattern, so a hit proves the walk descended
  // (i.e. the test fails loudly if pruning regresses, not just by luck).
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "node_modules", "pkg", "MANTLE.md"), "mantle in deps");
  mkdirSync(join(root, ".venv", "lib"), { recursive: true });
  writeFileSync(join(root, ".venv", "lib", "MANTLE.md"), "mantle in venv");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("walkFiles directory pruning", () => {
  it("glob_files finds source matches but skips node_modules/.venv", async () => {
    const res = await glob.execute({ pattern: "**/MANTLE.md", path: root }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain(join(root, "src", "MANTLE.md"));
    expect(res.content).not.toContain("node_modules");
    expect(res.content).not.toContain(".venv");
  });

  it("grep_files searches source but skips pruned dirs", async () => {
    const res = await grep.execute({ pattern: "mantle", path: root }, ctx());
    expect(res.content).toContain(join(root, "src", "MANTLE.md"));
    expect(res.content).not.toContain("node_modules");
    expect(res.content).not.toContain(".venv");
  });

  it("descends a base path that IS an ignored dir (explicit scope wins)", async () => {
    // The root itself is never matched against the ignore set — only its
    // descendants are — so scoping `path` into node_modules still searches it.
    const res = await glob.execute(
      { pattern: "**/MANTLE.md", path: join(root, "node_modules") },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain(join(root, "node_modules", "pkg", "MANTLE.md"));
  });
});
