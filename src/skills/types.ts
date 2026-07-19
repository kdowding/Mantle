// Where a skill was discovered. Drives the path alias in the catalog
// (`{workspace}/skills/...` vs `{global}/...`) and read_file's
// resolution. Workspace-scoped skills override globals on name conflict.
export type SkillSource = "workspace" | "global";

export interface Skill {
  name: string;
  description: string;
  // Absolute path. Used for stat/read and for converting to an alias
  // form in the prompt catalog (so the model sees the alias and
  // read_file resolves it back to absolute).
  filePath: string;
  source: SkillSource;
  // Full SKILL.md body content (everything after the frontmatter).
  // Populated regardless of `always` flag — formatter decides what
  // to do with it. Bounded by MAX_SKILL_FILE_BYTES (256K) per file.
  body: string;
  // When true, skill body renders in the prompt's `# Standing Skills`
  // section every turn — the agent ALWAYS applies it. When false
  // (default), the skill appears only as a one-line entry in the
  // triggered-skills catalog and the agent loads its body via
  // read_file when relevant. Sparse set — 3-5 max for token cost.
  always: boolean;
  platform?: string;
}

export interface SkillSnapshot {
  // Full body content for `always: true` skills, ready to inline in
  // the stable zone's `# Standing Skills` section. Empty when no
  // always-on skills exist.
  standingBodies: string;
  // Compact one-line catalog of triggered skills for the dynamic
  // zone. Each line: `- name — description (read: {alias-path})`.
  // Empty when no triggered skills exist.
  catalog: string;
  // The skills that ended up in the prompt (post-cap, post-filter).
  // Used by /api/agents/:id/skills for the UI's skill panel.
  skills: Skill[];
}
