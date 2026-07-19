import { test, expect } from "bun:test";
import { resolve } from "path";
import { createMantleGuideTool } from "./mantle-guide.js";

// Point at the real repo root so we exercise the committed docs/agent-manual/.
const basePath = resolve(import.meta.dir, "..", "..", "..");
const tool = createMantleGuideTool(basePath);

test("mantle_guide lists the corpus pages and excludes _proposed-templates", async () => {
  const r = await tool.execute({});
  expect(r.isError).toBeFalsy();
  expect(r.content).toContain("docs/agent-manual/feature/voice.md");
  expect(r.content).toContain("docs/agent-manual/feature/call.md");
  expect(r.content).toContain("docs/agent-manual/management/soul.md");
  expect(r.content).not.toContain("_proposed-templates");
});

test("mantle_guide fetches a page by full or bare path", async () => {
  const full = await tool.execute({ doc: "docs/agent-manual/feature/voice.md" });
  expect(full.isError).toBeFalsy();
  expect(full.content.length).toBeGreaterThan(200);

  const bare = await tool.execute({ doc: "feature/call.md" });
  expect(bare.isError).toBeFalsy();
  expect(bare.content.length).toBeGreaterThan(200);
});

test("mantle_guide blocks path traversal outside the manual", async () => {
  // CLAUDE.md is a real .md file at the repo root — only the containment
  // check (not the .md filter) can block it.
  const r = await tool.execute({ doc: "../../CLAUDE.md" });
  expect(r.isError).toBe(true);
  expect(r.content).toContain("outside the manual");
});

test("mantle_guide reports a missing page", async () => {
  const r = await tool.execute({ doc: "feature/nonexistent.md" });
  expect(r.isError).toBe(true);
  expect(r.content).toContain("No manual page");
});
