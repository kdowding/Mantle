import type { Skill, SkillSnapshot } from "./types.js";

// Cap on the compact catalog (triggered-skills list) in chars. Lower
// than the old 18K full-format budget because the new format is
// denser AND we don't need the model to read every entry — it scans
// for relevance. Roughly 30 skills @ 100 chars per line = 3K chars.
// The 3-tier degradation (full → trim) below preserves the old
// safety net for unusually large skill catalogs.
const DEFAULT_CATALOG_MAX_CHARS = 6_000;

// Cap on the standing-skills section in chars. This is the inlined
// FULL body content for `always: true` skills — every standing skill's
// body is sent every turn, so the cost matters. Skills here ought to
// be short by convention (a foundational instruction is typically
// 200-1000 chars), so 12K is generous for 3-5 always-on skills.
// Overflow drops the lowest-priority bodies (alphabetical tail) with
// a truncation notice.
const DEFAULT_STANDING_MAX_CHARS = 12_000;

const STANDING_PREAMBLE =
  "You always apply the standing skills below. They are not optional — " +
  "treat them as part of your operating procedure for every response. " +
  "Each skill's full content is inlined; do not need to load it via read_file.";

const CATALOG_PREAMBLE =
  "Specialized skills you can load when relevant. Each line is `name — description (read: <path>)`. " +
  "When the user's task matches a skill's description, call `read_file` with the path shown to load " +
  "the skill's full instructions. Path aliases: `{workspace}` is your agent workspace, `{global}` is " +
  "the shared skills directory — read_file resolves both automatically.";

export interface FormatOptions {
  catalogMaxChars?: number;
  standingMaxChars?: number;
}

export function formatSkillsForPrompt(
  skills: Skill[],
  options: FormatOptions = {},
): SkillSnapshot {
  if (skills.length === 0) {
    return { standingBodies: "", catalog: "", skills: [] };
  }

  const catalogMax = options.catalogMaxChars ?? DEFAULT_CATALOG_MAX_CHARS;
  const standingMax = options.standingMaxChars ?? DEFAULT_STANDING_MAX_CHARS;

  // Partition into always-on vs triggered. Always-on bodies inline
  // in the stable zone; triggered names+descriptions go into the
  // dynamic-zone catalog.
  const alwaysOn = skills.filter((s) => s.always);
  const triggered = skills.filter((s) => !s.always);

  const standingBodies = buildStandingSection(alwaysOn, standingMax);
  const catalog = buildCatalog(triggered, catalogMax);

  return { standingBodies, catalog, skills };
}

// Inline the full body of every always-on skill under
// `# Standing Skills`. Each skill becomes a `## name` block followed
// by its body. Bodies stay verbatim from the SKILL.md — the file
// authors are responsible for keeping standing skills concise.
function buildStandingSection(alwaysOn: Skill[], maxChars: number): string {
  if (alwaysOn.length === 0) return "";

  const sections: string[] = [STANDING_PREAMBLE, ""];
  let droppedNames: string[] = [];

  // Build incrementally and stop once we'd blow the cap. Alphabetical
  // ordering is already in place from loadSkills, so "lowest priority"
  // here just means alphabetical-tail — predictable, not random.
  let used = STANDING_PREAMBLE.length + 1;
  for (const skill of alwaysOn) {
    const section = `## ${skill.name}\n\n${skill.body.trim()}`;
    if (used + section.length + 2 > maxChars) {
      droppedNames.push(skill.name);
      continue;
    }
    sections.push(section);
    used += section.length + 2;
  }

  if (droppedNames.length > 0) {
    sections.push(
      `*Note: ${droppedNames.length} additional always-on skill(s) ` +
      `(${droppedNames.join(", ")}) were dropped from this prompt — ` +
      `the standing-skills section hit its ${maxChars.toLocaleString()}-char cap. ` +
      `Use read_file to load them on demand if relevant.*`,
    );
  }

  return sections.join("\n\n");
}

// Compact catalog of triggered skills — one line per skill. Each
// line is `- name — description (read: <aliased-path>)`. Aliased
// paths use {workspace}/skills/<name> or {global}/<name>; read_file
// resolves both at call time so the model sees stable references
// regardless of which machine mantle is running on.
function buildCatalog(triggered: Skill[], maxChars: number): string {
  if (triggered.length === 0) return "";

  const tryWith = (skills: Skill[]): string => {
    if (skills.length === 0) return "";
    const lines = skills.map((s) => {
      const aliased = aliasedPath(s);
      // Trim description to one logical line — collapse internal
      // newlines, keep it terse.
      const desc = s.description.replace(/\s+/g, " ").trim();
      return `- ${s.name} — ${desc} (read: ${aliased})`;
    });
    return `${CATALOG_PREAMBLE}\n\n${lines.join("\n")}`;
  };

  const full = tryWith(triggered);
  if (full.length <= maxChars) return full;

  // Over budget — binary-search the largest alphabetical prefix that
  // fits. Same degradation pattern openclaw uses. The dropped tail
  // is hidden from the catalog but the model can still read those
  // SKILL.md files by hand if it learns about them through other
  // means (rare; usually fine).
  let lo = 1;
  let hi = triggered.length;
  let best = "";
  let bestCount = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = tryWith(triggered.slice(0, mid));
    if (candidate.length <= maxChars) {
      best = candidate;
      bestCount = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (bestCount < triggered.length && best) {
    const omitted = triggered.length - bestCount;
    best += `\n\n*Note: ${omitted} additional skill(s) omitted to fit the ${maxChars.toLocaleString()}-char catalog cap.*`;
  }

  return best;
}

// Convert a skill's absolute filePath to an aliased form for the
// prompt. Workspace skills get `{workspace}/skills/<name>/SKILL.md`,
// global skills get `{global}/<name>/SKILL.md`. read_file's resolver
// reverses these to absolute paths at call time, so:
//   - Cache: the path text in the prompt stays identical across
//     machines, so renames of $HOME or the mantle install dir don't
//     bust the stable cache.
//   - Portability: the prompt isn't tied to any user's filesystem.
function aliasedPath(skill: Skill): string {
  if (skill.source === "workspace") {
    return `{workspace}/skills/${skill.name}/SKILL.md`;
  }
  // Global skills live directly under the global skills root; no
  // intermediate "skills" subdirectory like the workspace pattern.
  return `{global}/${skill.name}/SKILL.md`;
}
