import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { resolve, join } from "path";
import YAML from "yaml";
import { formatSkillsForPrompt } from "./formatter.js";
import type { Skill, SkillSource } from "./types.js";
import type { MantleConfig, AgentConfig } from "../config/schema.js";

const SKILL_FILE = "SKILL.md";
const MAX_SKILL_FILE_BYTES = 256_000;

// --- discovery cache --------------------------------------------------------
// discoverSkills runs ~7-9x per turn across dispatch sites (chat / heartbeat /
// cron / subagent / synthetic-turn / preview / api), each time re-reading and
// YAML-parsing every SKILL.md from disk. Skills change rarely, so cache the
// parsed result per directory, keyed on a cheap structural fingerprint: the
// immediate child-directory NAME SET (sorted) + each <dir>/<child>/SKILL.md
// mtimeMs:size. The name set is load-bearing — it busts the key when a skill
// dir is added or deleted even if every SURVIVING SKILL.md is byte-identical
// (a per-file stat sweep alone would miss a deletion). Mirrors the project's
// "stat, don't re-parse" precedent (the .git/HEAD direct read in prompt-builder).
function fingerprintDir(dir: string): string {
  if (!existsSync(dir)) return "∅"; // missing — distinct from an empty dir
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return "⚠"; // unreadable — stable, distinct key (no thrash)
  }
  const parts: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let sig = "-"; // dir present but no/unstattable SKILL.md
    try {
      const st = statSync(join(dir, e.name, SKILL_FILE));
      sig = `${st.mtimeMs}:${st.size}`;
    } catch {
      /* sig stays "-" */
    }
    // Include the name even with no SKILL.md so add/delete of a bare dir perturbs the key.
    parts.push(`${e.name}\u0000${sig}`);
  }
  parts.sort();
  return parts.join("\u0001");
}

interface DirCacheEntry { fp: string; skills: Skill[]; }
const dirCache = new Map<string, DirCacheEntry>(); // `${dir}|${source}` -> parsed Skill[]
const mergeCache = new Map<string, { gfp: string; afp: string; skills: Skill[] }>(); // agent.workspace -> merged
const snapshotCache = new Map<
  string,
  { gfp: string; afp: string; sig: string; snap: { standingSkills: string; skillsCatalog: string } }
>(); // agent.workspace -> formatted prompt strings

// Test/diagnostic hook — clears all three cache layers. Used by the harness.
export function __resetSkillCache(): void {
  dirCache.clear();
  mergeCache.clear();
  snapshotCache.clear();
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  platform?: string;
  // When true, the skill's full body inlines into the prompt's
  // `# Standing Skills` section every turn — the agent applies it
  // unconditionally. Default false (triggered-only via catalog).
  // Keep the always-on set sparse (3-5 max) to control token cost.
  always?: boolean;
}

// Exported for the skill-editor API — saves validate with the SAME parse
// discovery uses, so the editor can refuse writes that discovery would
// silently skip (no description = invisible skill).
export function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  const end = content.indexOf("---", 3);
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }

  const yamlBlock = content.slice(3, end).trim();
  const body = content.slice(end + 3).trim();

  try {
    const parsed = YAML.parse(yamlBlock);
    return { frontmatter: parsed ?? {}, body };
  } catch {
    return { frontmatter: {}, body: content };
  }
}

export function loadSkills(skillsDir: string, source: SkillSource): Skill[] {
  // Per-dir cache. source is part of the key because loadSkills bakes it into
  // every Skill, so the same path loaded as "global" vs "workspace" must not
  // collide. Cached array is returned BY REFERENCE — callers only read/map
  // /filter it (never mutate in place), so sharing is safe.
  const cacheKey = `${skillsDir}|${source}`;
  const fp = fingerprintDir(skillsDir);
  const hit = dirCache.get(cacheKey);
  if (hit && hit.fp === fp) return hit.skills;

  if (!existsSync(skillsDir)) {
    dirCache.set(cacheKey, { fp, skills: [] });
    return [];
  }

  const skills: Skill[] = [];

  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillFilePath = join(skillsDir, entry.name, SKILL_FILE);
      if (!existsSync(skillFilePath)) continue;

      // Check file size
      try {
        const stat = statSync(skillFilePath);
        if (stat.size > MAX_SKILL_FILE_BYTES) continue;
      } catch {
        continue;
      }

      try {
        const content = readFileSync(skillFilePath, "utf-8");
        const { frontmatter, body } = parseFrontmatter(content);

        const name = frontmatter.name ?? entry.name;
        const description = frontmatter.description ?? "";

        // Skip skills without a description
        if (!description) continue;

        // Platform filter
        if (frontmatter.platform) {
          const platform = process.platform === "win32" ? "windows"
            : process.platform === "darwin" ? "macos"
            : "linux";
          if (frontmatter.platform !== platform) continue;
        }

        skills.push({
          name,
          description,
          filePath: resolve(skillFilePath),
          source,
          body,
          always: frontmatter.always === true,
          platform: frontmatter.platform,
        });
      } catch {
        // Skip unreadable skills
      }
    }
  } catch {
    // Skills directory unreadable
  }

  // Sort alphabetically for deterministic prompt ordering
  skills.sort((a, b) => a.name.localeCompare(b.name));

  dirCache.set(cacheKey, { fp, skills });
  return skills;
}

// Discover and merge skills from global + agent-specific directories.
// Agent skills take precedence on name conflict — the source tag
// preserves which directory each came from so the formatter can
// pick the right alias prefix.
export function discoverSkills(config: MantleConfig, agent: AgentConfig): Skill[] {
  const agentSkillsDir = resolve(agent.workspace, "skills");
  const gfp = fingerprintDir(config.globalSkillsDir);
  const afp = fingerprintDir(agentSkillsDir);
  // Keyed on the two dir fingerprints ONLY — NOT on any enable/disable
  // signature, because this returns the UNFILTERED merged list (api.ts maps
  // it for the per-agent skill UI). One entry per agent workspace.
  const hit = mergeCache.get(agent.workspace);
  if (hit && hit.gfp === gfp && hit.afp === afp) return hit.skills;

  const agentSkills = loadSkills(agentSkillsDir, "workspace");

  let globalSkills: Skill[] = [];
  if (existsSync(config.globalSkillsDir)) {
    globalSkills = loadSkills(config.globalSkillsDir, "global");
  }

  const agentSkillNames = new Set(agentSkills.map((s) => s.name));
  const merged = [
    ...agentSkills,
    ...globalSkills.filter((s) => !agentSkillNames.has(s.name)),
  ];
  mergeCache.set(agent.workspace, { gfp, afp, skills: merged });
  return merged;
}

// Filter skills based on global + per-agent enable/disable state.
// Resolution order: agent disable > agent enable (overrides global disable) > global disable > enabled by default.
export function filterSkills(
  skills: Skill[],
  globalDisabled: string[],
  agentDisabled: string[],
  agentEnabled: string[],
): Skill[] {
  const globalDisabledSet = new Set(globalDisabled);
  const agentDisabledSet = new Set(agentDisabled);
  const agentEnabledSet = new Set(agentEnabled);

  return skills.filter((skill) => {
    if (agentDisabledSet.has(skill.name)) return false;
    if (agentEnabledSet.has(skill.name)) return true;
    if (globalDisabledSet.has(skill.name)) return false;
    return true;
  });
}

// Assemble the prompt-ready skills surface for an agent in one call:
// discover (global + workspace) → filter (global + per-agent
// enable/disable) → format into the two strings buildSystemPrompt
// consumes. This is the single home for the discover→filter→format
// triad; every turn site (chat, heartbeat, cron, background,
// sub-agent, system-prompt preview) calls this instead of re-spelling
// it. Returns empty strings when the agent has no active skills —
// callers map "" to undefined as they prefer.
export function resolveAgentSkillsForPrompt(
  config: MantleConfig,
  agent: AgentConfig,
): { standingSkills: string; skillsCatalog: string } {
  const agentSkillsDir = resolve(agent.workspace, "skills");
  const gfp = fingerprintDir(config.globalSkillsDir);
  const afp = fingerprintDir(agentSkillsDir);
  const globalDisabled = config.skills?.disabled ?? [];
  const agentDisabled = agent.disabledSkills ?? [];
  const agentEnabled = agent.enabledSkills ?? [];
  // The FORMATTED snapshot depends on which skills survive filtering, so the
  // filter signature MUST enter the key here (unlike discoverSkills). Lists
  // are sorted for order-insensitivity; control-char separators (within each
  // list AND between fields) make distinct configs distinct keys — otherwise
  // {globalDisabled:["x"]} and {agentEnabled:["x"]} (different filter output,
  // since agentEnabled overrides globalDisabled) would collide and pin a stale
  // prompt across a live toggle. Item and field separators are distinct so configs never collide on a plain join.
  const sig = [
    process.platform,
    [...globalDisabled].sort().join("\u0001"),
    [...agentDisabled].sort().join("\u0001"),
    [...agentEnabled].sort().join("\u0001"),
  ].join("\u0002");
  const hit = snapshotCache.get(agent.workspace);
  if (hit && hit.gfp === gfp && hit.afp === afp && hit.sig === sig) return hit.snap;

  const merged = discoverSkills(config, agent);
  const active = filterSkills(merged, globalDisabled, agentDisabled, agentEnabled);
  const { standingBodies, catalog } = formatSkillsForPrompt(active);
  const snap = { standingSkills: standingBodies, skillsCatalog: catalog };
  snapshotCache.set(agent.workspace, { gfp, afp, sig, snap });
  return snap;
}
