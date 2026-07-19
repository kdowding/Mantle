// Skill discovery tests — wires in the declared __resetSkillCache test
// hook and pins the agent-wins-on-name-conflict + fingerprint-cache
// behaviors.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { discoverSkills, __resetSkillCache } from "./loader.js";
import type { MantleConfig, AgentConfig } from "../config/schema.js";

function skillMd(dir: string, name: string, description: string): void {
  const d = resolve(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    resolve(d, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`,
    "utf-8",
  );
}

let globalDir: string;
let workspace: string;
let config: MantleConfig;
let agent: AgentConfig;

beforeEach(() => {
  __resetSkillCache();
  globalDir = mkdtempSync(join(tmpdir(), "mantle-skills-g-"));
  workspace = mkdtempSync(join(tmpdir(), "mantle-skills-w-"));
  config = { globalSkillsDir: globalDir, skills: { disabled: [] } } as unknown as MantleConfig;
  agent = { id: "t", name: "T", workspace } as AgentConfig;
});

describe("discoverSkills", () => {
  test("merges global + agent dirs; agent wins on name conflict", () => {
    skillMd(globalDir, "shared", "global version");
    skillMd(globalDir, "global-only", "only global");
    skillMd(resolve(workspace, "skills"), "shared", "agent version");

    const skills = discoverSkills(config, agent);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["global-only", "shared"]);
    expect(skills.find((s) => s.name === "shared")!.description).toBe("agent version");
  });

  test("fingerprint cache serves a stable list; __resetSkillCache forces re-read", () => {
    skillMd(globalDir, "alpha", "v1");
    const first = discoverSkills(config, agent);
    expect(first).toHaveLength(1);

    // Same-tick rewrite can defeat mtime granularity — this is exactly why
    // the reset hook exists for tests.
    skillMd(globalDir, "beta", "new skill");
    __resetSkillCache();
    const second = discoverSkills(config, agent);
    expect(second.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
  });

  test("a SKILL.md without a description is skipped", () => {
    const d = resolve(globalDir, "nodesc");
    mkdirSync(d, { recursive: true });
    writeFileSync(resolve(d, "SKILL.md"), `---\nname: nodesc\n---\n\nBody.\n`, "utf-8");
    expect(discoverSkills(config, agent)).toHaveLength(0);
  });
});
