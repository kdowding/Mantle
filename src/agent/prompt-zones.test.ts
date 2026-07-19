// buildSystemPrompt zone placement — pins which zone each movable section
// lands in, because placement IS the cache contract: stable-zone content
// re-caches only when it changes; dynamic-zone content rides the per-turn
// splice into the latest user message (extractDynamicZone). The triggered-
// skills catalog moved dynamic → stable in 2026-07 to keep that splice lean
// (its session-opener shape had weaker models re-greeting mid-chat) — this
// test is the regression guard on that move.
import { describe, test, expect } from "bun:test";
import { buildSystemPrompt } from "./prompt-builder.js";

// A workspace path with no files on disk — workspace-file reads are
// best-effort, so the builder still assembles all three zones.
const WORKSPACE = "/nonexistent-mantle-prompt-zones-test";

describe("buildSystemPrompt zone placement", () => {
  test("triggered-skills catalog renders in STABLE, not dynamic", () => {
    const prompt = buildSystemPrompt({
      workspacePath: WORKSPACE,
      skillsCatalog: "- demo-skill — does demo things (read: {global}/demo-skill/SKILL.md)",
    });
    expect(prompt.stable).toContain("# Available Skills");
    expect(prompt.stable).toContain("demo-skill");
    expect(prompt.dynamic).not.toContain("# Available Skills");
  });

  test("standing skills render in STABLE alongside the catalog", () => {
    const prompt = buildSystemPrompt({
      workspacePath: WORKSPACE,
      standingSkills: "## always-on\nbody text",
      skillsCatalog: "- demo-skill — does demo things",
    });
    const standingIdx = prompt.stable.indexOf("# Standing Skills");
    const catalogIdx = prompt.stable.indexOf("# Available Skills");
    expect(standingIdx).toBeGreaterThan(-1);
    expect(catalogIdx).toBeGreaterThan(standingIdx);
  });

  test("per-turn content stays dynamic: memory pack + date/time", () => {
    const prompt = buildSystemPrompt({
      workspacePath: WORKSPACE,
      memoryPack: "# Recalled Memories\n\n- a memory",
      skillsCatalog: "- demo-skill — does demo things",
    });
    expect(prompt.dynamic).toContain("# Recalled Memories");
    expect(prompt.dynamic).toContain("# Current Date & Time");
    expect(prompt.stable).not.toContain("# Recalled Memories");
    expect(prompt.stable).not.toContain("# Current Date & Time");
  });
});
