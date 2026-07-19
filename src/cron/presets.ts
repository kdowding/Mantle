// Cron run presets — the (context × tool-surface) bundles a scheduled job runs
// under. The security model lives here: an unspecified job is "mechanical" (the
// crawl-and-report archetype — lean context, read+report tools, nothing that
// executes, writes, or exfiltrates), and a job opts UP to richer context / the
// full tool surface only deliberately. Least privilege by default.
//
// Two axes, deliberately paired into presets rather than left as free knobs:
//   - context (economy): which identity files load, recall depth, skills,
//     baseline. NOT a security control — it's about not paying for SOUL/memory
//     a mechanical job doesn't use.
//   - tools (security): the real blast-radius bound. The safe set below is
//     read-only; the dangerous capabilities (bash, write, research, web-MCP)
//     are excluded by omission, not by a deny-list.
//
// CRON.md (the always-on autonomy floor, prompt-builder's CRON_MODE_PROMPT)
// carries the security + conduct rules for an unattended run — so AGENTS.md (the
// chat-time baseline) is NOT loaded for scheduled runs at all. Hard per-agent
// limits live in disabledTools; job-specific boundaries live in the job prompt
// or a personality file.

import type { CronContext, CronPayload, CronPresetName, CronWorkspaceFile } from "./types.js";

// The read-only + report tool surface every NON-companion preset runs with.
// Memory + web + session + filesystem READS — nothing that executes, writes,
// or wrecks. brave_web_search is included on purpose: clean structured results
// beat scraping a search engine's HTML through web_fetch (which is what a
// search-less crawl-and-report job falls back to). Its query egresses via the
// MCP server, which egressDomains can't fence — but that's a search-query's
// worth of text to Brave, not an attacker-reachable channel, so it stays OUT
// of BLIND_EGRESS_TOOLS (no standing warning on the default presets). Excluded
// by omission: bash (uncontained shell), write_file/edit_file (self-prompt
// poisoning), attach_*/render_session_markdown (disk write + browser serve),
// spawn_agent, englyph_research (a heavier blind egress — a full crawl, not a
// query). cron_report / cron_snooze are pinned pseudo-tools — they bypass this
// allow-list entirely. (brave_web_search only resolves when the brave MCP
// server is configured; an unregistered name simply never enters the surface.)
export const SAFE_CRON_TOOLS: readonly string[] = [
  "recall", "recall_history", "recall_area", "expand_memory", "memory_status",
  "web_fetch", "brave_web_search",
  "read_file", "list_directory", "glob_files", "grep_files",
  "sessions_list", "sessions_history",
];

export interface CronPreset {
  context: Required<CronContext>;
  // Tool allow-list for the run. undefined = the full registry surface (minus
  // the agent's disabledTools). A privilege-contained creating turn still caps
  // this — see resolveCronToolsAllow.
  tools?: readonly string[];
}

export const CRON_PRESETS: Record<CronPresetName, CronPreset> = {
  // Least privilege + the crawl-and-report archetype. The security-first
  // DEFAULT: identity only, read+report tools, nothing that writes or executes
  // (CRON.md is the conduct floor). The worst an injected run can do is report
  // wrong content — it can't leak or wreck.
  mechanical: {
    context: { workspaceFiles: ["IDENTITY"], memoryPack: false, skills: false, baseline: true },
    tools: SAFE_CRON_TOOLS,
  },
  // Knows who/whose it is + light recall, still read+report only. For check-ins
  // and reflections that reason about the user but never act on the host.
  aware: {
    context: { workspaceFiles: ["IDENTITY", "USER", "MEMORY"], memoryPack: true, skills: false, baseline: true },
    tools: SAFE_CRON_TOOLS,
  },
  // The full companion: every identity file, SOUL, skills, the memory pack, and
  // the full tool surface. For jobs that should sound like the agent AND may
  // act — an explicit opt-in, never the default.
  companion: {
    context: { workspaceFiles: ["SOUL", "IDENTITY", "USER", "MEMORY"], memoryPack: true, skills: true, baseline: true },
    tools: undefined,
  },
};

export const DEFAULT_CRON_PRESET: CronPresetName = "mechanical";

export function isCronPresetName(v: unknown): v is CronPresetName {
  return v === "mechanical" || v === "aware" || v === "companion";
}

function presetFor(name: CronPresetName | undefined): CronPreset {
  return CRON_PRESETS[name ?? DEFAULT_CRON_PRESET] ?? CRON_PRESETS[DEFAULT_CRON_PRESET];
}

// Resolve a job's effective run context: the preset's defaults with any per-job
// override fields layered on top. Pure — unit-tested directly.
export function resolveCronContext(
  payload: Pick<CronPayload, "preset" | "context">,
): Required<CronContext> {
  const base = presetFor(payload.preset).context;
  const o = payload.context ?? {};
  return {
    workspaceFiles: o.workspaceFiles ?? base.workspaceFiles,
    memoryPack: o.memoryPack ?? base.memoryPack,
    skills: o.skills ?? base.skills,
    baseline: o.baseline ?? base.baseline,
  };
}

// Resolve the effective tool allow-list for a run. A stored toolsAllow is
// privilege containment from the creating turn (or an explicit override) and
// ALWAYS wins — a job can never run with more than the surface it was minted
// under. Otherwise the preset's tools apply. undefined = the full surface.
export function resolveCronToolsAllow(
  payload: Pick<CronPayload, "preset" | "toolsAllow">,
): readonly string[] | undefined {
  if (payload.toolsAllow && payload.toolsAllow.length > 0) return payload.toolsAllow;
  return presetFor(payload.preset).tools;
}

// Map the short workspace-file names to the prompt-builder's WORKSPACE_FILES
// filenames ("AGENTS" → "AGENTS.md"). undefined → the builder renders all five.
export function cronWorkspaceFilenames(files: CronWorkspaceFile[] | undefined): string[] | undefined {
  return files ? files.map((f) => `${f}.md`) : undefined;
}

// Capabilities that can send data to places mantle CAN'T monitor — egress the
// per-job allow-list (web_fetch/attach_url) doesn't cover: the shell, the
// Englyph-side research crawl, and (via the full surface) any web MCP server.
const BLIND_EGRESS_TOOLS = new Set(["bash", "englyph_research", "englyph_research_async"]);

// Describe a job's blind-egress exposure for a creation-time warning (H6), or
// null when the resolved surface is safe. The full surface (companion / no
// allow-list) inherently includes blind-egress tools; an explicit list is
// flagged for the specific ones it names. Pure + unit-tested.
export function blindEgressDescription(
  payload: Pick<CronPayload, "preset" | "toolsAllow">,
): string | null {
  const tools = resolveCronToolsAllow(payload);
  if (tools === undefined) return "the full tool surface (bash, research, and any MCP server)";
  const flagged = tools.filter((t) => BLIND_EGRESS_TOOLS.has(t));
  return flagged.length > 0 ? flagged.join(", ") : null;
}

// Sanitize a raw egress-domains input (tool arg / REST body / UI form) → a clean
// string[] (trimmed, lowercased, empties dropped) or undefined. Matching lives
// in net-guard (hostInAllowList); this just normalizes the supplied list.
export function normalizeEgressDomains(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out = input.map((d) => String(d).trim().toLowerCase()).filter((d) => d.length > 0);
  return out.length > 0 ? out : undefined;
}
