// Deck assist — the agent embedded on the systems-deck pages (cron /
// skills), chatting about the OPEN artifact and proposing
// staged edits the user accepts or discards as a diff (the Cursor model).
//
// Shape: the assist conversation is a REAL but HIDDEN per-agent session
// (isAssist — filtered from the chat sidebar), driven through the shared front
// door. The client sends only the NEW user turn + the current artifact; the
// server appends it to the persisted `assist` session, compacts if needed, runs
// ONE turn (pseudo-tools: propose_edit + staged systems actions), streams text
// deltas back, and reports the captured changeset + the turn's context usage in
// assist_done. The conversation survives refresh AND restart; the dock loads it
// from GET /api/agents/:id/assist/session and clears it via DELETE.
// FILE edits NEVER touch disk here — they land in the page's editor buffer
// client-side, and the page's existing save path stays the only writer.
//
// Wire: in  { type:"assist_message", agentId, assistId, content: JSON }
//            content = { target: { kind, label, artifact }, message: "…new turn…" }
//       out { type:"assist_delta", assistId, text }
//           { type:"assist_done",  assistId, changeset?, actions?, usage?,
//                                  contextWindow?, compactionThreshold?, error? }

import { readFileSync, existsSync } from "fs";
import { resolve, dirname, basename } from "path";
import type { ServerWebSocket } from "bun";
import type { MantleConfig, AgentConfig } from "../config/schema.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { LocalModelManager } from "../local/manager.js";
import type { TokenUsage } from "../agent/providers/types.js";
import { getAgent } from "../config/loader.js";
import { parseFrontmatter, discoverSkills } from "../skills/loader.js";
import { isPersonalityFile, PERSONALITY_FILES } from "../agent/section-toggles.js";
import { SessionManager, type SessionMessage } from "../agent/session.js";
import { resolveProviderTurn } from "../agent/providers/catalog.js";
import { compactIfNeeded, effectiveCompactionThreshold, resolveContextWindow } from "../agent/compaction.js";
import { withAgentLock } from "../agent/agent-lock.js";
import { runTriggeredAgentTurn, type PseudoTool } from "../agent/triggered-turn.js";
import { buildMemoryPack } from "../agent/memory-pack.js";
import { json } from "./api-helpers.js";
import { chatToolHidden } from "./chat-tool-surface.js";
import type { ClientMessage, WsData } from "./ws-types.js";

const TARGET_KINDS = ["skill", "cron", "workspace"] as const;
type TargetKind = (typeof TARGET_KINDS)[number];

// The conversation lives in ONE hidden session per agent (continuous across all
// four deck pages). A fixed id is fine — it's namespaced under the agent's
// sessions dir, and the dock loads it via the per-agent REST route below (never
// the cross-agent /api/sessions/:id lookup).
const ASSIST_SESSION_ID = "assist";

interface AssistRequest {
  // openRef (skill kind): the open skill's on-disk identity, so a stage_skill_edit
  // aimed at the open file folds into the "open" entry (baseline = the editor
  // buffer in `artifact`, not stale disk).
  // create: nothing is open in the editor (no skill selected / no cron draft) —
  // the dock is in creation mode. propose_edit is dropped (no open artifact);
  // the agent creates via stage_skill_edit (skills) / cron_jobs create (cron).
  target: { kind: TargetKind; label: string; artifact: string; create?: boolean; openRef?: { scope?: "agent" | "global"; dir?: string; file?: string } };
  // The NEW user turn — the only message the server appends (the conversation
  // is now the persisted `assist` session, not client-shipped each time).
  // `messages` is the legacy whole-conversation shape, kept so an older client
  // keeps working: its last user entry is taken as the new turn.
  message?: string;
  messages?: Array<{ role: "user" | "assistant"; text: string }>;
  // Systems-action resolutions since the agent's last turn (confirmed/discarded
  // cards) — folded into context so the agent learns the outcome and doesn't
  // re-propose. Client-tracked (assist.svelte.ts).
  resolved?: Array<{ summary: string; status: "confirmed" | "discarded"; outcome?: string }>;
  // Inference selection mirrored from the chat profile bar (shared `prefs`) —
  // the user can run assist on a different backend / effort / memory than the
  // agent default. provider is a composite backend id. All optional — absent
  // falls back to the agent default.
  provider?: string;
  model?: string;
  thinkingLevel?: "off" | "low" | "medium" | "high";
  memoryPack?: boolean;
  // One-line-per-item summary of changes/actions currently staged in the client
  // and awaiting the user's decision — folded into context so the agent stays
  // aware of pending work across a conversation clear / refresh.
  staged?: string[];
}

// One staged systems action awaiting the user's confirm/discard. `params` is the
// full tool input; on confirm the client POSTs it to /api/assist/action, which
// runs the real tool. `summary` is the one-line card description.
interface StagedAction {
  id: string;
  kind: string;        // e.g. "cron.create"
  summary: string;
  params: Record<string, unknown>;
}

function summarizeCronAction(action: string, input: Record<string, unknown>): string {
  const who = input.name ? `"${String(input.name)}"` : input.job_id ? `job ${String(input.job_id).slice(0, 8)}` : "job";
  if (action === "create") {
    const sched = input.schedule_kind === "cron" ? `cron ${input.schedule_cron ?? ""}`
      : input.schedule_kind === "every" ? `every ${Math.round(Number(input.schedule_every_ms ?? 0) / 60000)}m`
      : input.schedule_kind === "at" ? `at ${input.schedule_at ?? ""}`
      : "";
    return `Create cron job ${who} · ${sched} · delivery ${input.delivery ?? "agent"}`;
  }
  if (action === "update") return `Update cron ${who}${input.enabled !== undefined ? ` · ${input.enabled ? "enable" : "disable"}` : ""}`;
  if (action === "delete") return `Delete cron ${who}`;
  return `${action} cron ${who}`;
}

function summarizeSkillAction(action: string, input: Record<string, unknown>): string {
  if (action === "delete") return `Delete skill ${input.scope ?? "?"}/${input.dir ?? "?"}`;
  if (action === "enable") return `Enable skill "${input.name ?? "?"}"`;
  if (action === "disable") return `Disable skill "${input.name ?? "?"}"`;
  return `${action} skill`;
}

// One reviewable file in the staged changeset returned by a turn. "open" = the
// artifact in the deck editor (accept → buffer); "skill" = another SKILL.md
// (accept → skills file API). Baseline + full content; the client diffs them.
interface StagedFile {
  id: string;                 // "open" | `skill:${scope}:${dir}` | `ws:${file}`
  label: string;
  kind: "open" | "skill" | "workspace";
  scope?: "agent" | "global";
  dir?: string;
  file?: string;              // workspace kind: the personality filename
  isNew?: boolean;
  baseline: string;
  content: string;
  note?: string;
}

// Current on-disk SKILL.md for (scope, dir), or empty + isNew for a file the
// agent is creating. dir is regex-validated by the caller (single safe segment,
// no traversal), so resolve() stays under the root.
function readSkillBaseline(
  config: MantleConfig,
  agent: AgentConfig,
  scope: "agent" | "global",
  dir: string,
): { baseline: string; isNew: boolean } {
  const root = scope === "global" ? config.globalSkillsDir : resolve(agent.workspace, "skills");
  const file = resolve(root, dir, "SKILL.md");
  try {
    if (existsSync(file)) return { baseline: readFileSync(file, "utf-8"), isNew: false };
  } catch { /* unreadable → treat as new */ }
  return { baseline: "", isNew: true };
}

// Per-target format crib — the assist block teaches the model the artifact's
// rules so proposals come out valid (kept tight; this rides every turn).
const CRIB: Record<TargetKind, string> = {
  skill:
    "The artifact is a SKILL.md. YAML frontmatter REQUIRES `description:` (without it discovery silently skips the skill — never propose content missing it); optional `name`, `always: true` (full body in every prompt — keep rare), `platform` (windows/macos/linux). Body = the instructions the agent follows when the skill triggers. Write descriptions as WHEN-to-use trigger lines.",
  cron:
    "The artifact is a cron job spec. Keys: `name`, `schedule` (`every 30m|2h|1d` · `cron <expr> [tz <zone>]` · `at <ISO or relative like 20m>`), `delivery` (agent|message|notify|silent — agent means the run's cron_report notify flag decides what reaches the user), `session` (isolated|persistent), then `prompt: |` with the run's instructions indented below. Keep ALL keys present. Good prompts tell the agent what to check, what counts as noteworthy, and remind it to finish with cron_report.",
  workspace:
    "The artifact is one of this agent's personality files. AGENTS.md = operating rules, safety boundaries, and judgment (the user-owned guardrails). IDENTITY.md = name, tagline, and one-line purpose (the first line feeds the profile bar). SOUL.md = voice, values, and way of being — loaded into EVERY chat turn (autonomous cron runs may skip it). USER.md = what the agent knows about its user. MEMORY.md = a small curated list of pinned facts always in the prompt (distinct from the larger Englyph pool). CALL.md = the lean realtime-call persona, used ALONE on a voice call (a short paragraph; no markdown or stage directions). These are persona files — propose changes and let the user ratify.",
};

// Builder-skill bodies that teach the agent HOW to help on each page — the
// craft for that artifact, loaded from assist-skills/ at turn time (live-
// editable) and supplanting the one-line CRIB above (kept as a fallback if a
// file is missing). Bundled with mantle, invisible to the chat skill catalog.
const KIND_TO_BUILDER: Record<TargetKind, string> = {
  skill: "skill-builder",
  cron: "cron-builder",
  workspace: "personality-builder",
};

// Assist inherits the live chat agent's tool surface (so it can ground a
// proposal in the web, memory, sessions, and the workspace) MINUS this withheld
// set. The contract that makes the wide surface safe: nothing here writes to
// disk or runs shell — every file change rides propose_edit / stage_* as a
// reviewable diff, and the systems mutators (cron_jobs / skills_manage) ride as
// STAGED pseudo-tools. So we drop the disk/shell writers, the staged-pseudo
// registry twins, and the async tools whose deps the assist turn doesn't wire.
const ASSIST_WITHHELD_TOOLS: ReadonlySet<string> = new Set([
  "write_file", "edit_file", "bash",        // would bypass the staged-diff review
  "spawn_agent", "englyph_research_async",   // need subagent/background deps assist omits
  "cron_jobs", "skills_manage",              // provided as staged pseudo-tools per page
]);

function loadBuilderSkill(basePath: string, kind: TargetKind): string | null {
  try {
    const p = resolve(basePath, "assist-skills", KIND_TO_BUILDER[kind], "SKILL.md");
    if (!existsSync(p)) return null;
    const { body } = parseFrontmatter(readFileSync(p, "utf-8"));
    return body.trim() || null;
  } catch {
    return null;
  }
}

// A compact map of the agent's skills (agent + global) so the assist agent is
// oriented like a coding harness — names + descriptions + read paths it can
// pull in full via read_file. The open skill is flagged (its body is already
// in the prompt). Best-effort; an empty/unreadable skills tree yields "".
function buildSkillsMap(config: MantleConfig, agent: AgentConfig, openLabel: string): string {
  let skills: ReturnType<typeof discoverSkills> = [];
  try {
    skills = discoverSkills(config, agent);
  } catch {
    return "";
  }
  if (skills.length === 0) return "";
  const openDir = openLabel.split(/[\\/]/)[0];
  const lines = skills.slice(0, 40).map((s) => {
    const scope = s.source === "global" ? "global" : "agent";
    const dir = basename(dirname(s.filePath));
    const readPath = scope === "global" ? `{global}/${dir}/SKILL.md` : `{workspace}/skills/${dir}/SKILL.md`;
    const open = dir === openDir ? " (open · edit via propose_edit)" : "";
    const desc = s.description.length > 110 ? `${s.description.slice(0, 110)}…` : s.description;
    return `- [${scope}] ${s.name} (dir: ${dir})${open} — ${desc} · read: ${readPath}`;
  });
  const more = skills.length > 40 ? `\n- …and ${skills.length - 40} more` : "";
  return `## Skills in this workspace\nRead any in full with read_file before changing it; address an edit with its scope + dir. To create a new skill, stage_skill_edit a dir that isn't listed.\n${lines.join("\n")}${more}`;
}

export function routeAssistMessage(
  ws: ServerWebSocket<WsData>,
  msg: ClientMessage,
  config: MantleConfig,
  registry: ToolRegistry,
  deps: { localModelManager?: LocalModelManager },
): boolean {
  if (msg.type !== "assist_message") return false;
  void handleAssist(ws, msg, config, registry, deps).catch((err) => {
    try {
      ws.send(JSON.stringify({
        type: "assist_done",
        assistId: msg.assistId,
        error: err instanceof Error ? err.message : String(err),
      }));
    } catch { /* socket gone */ }
  });
  return true;
}

async function handleAssist(
  ws: ServerWebSocket<WsData>,
  msg: ClientMessage,
  config: MantleConfig,
  registry: ToolRegistry,
  deps: { localModelManager?: LocalModelManager },
): Promise<void> {
  const assistId = msg.assistId;
  const send = (m: Record<string, unknown>): void => {
    try { ws.send(JSON.stringify(m)); } catch { /* socket gone */ }
  };
  const fail = (error: string): void => send({ type: "assist_done", assistId, error });

  const agent = msg.agentId ? getAgent(config, msg.agentId) : undefined;
  if (!agent) return fail(`Unknown agent: ${msg.agentId}`);

  // ── Validate the structured request (content is client JSON — a claim) ──
  let req: AssistRequest;
  try {
    const raw = JSON.parse(msg.content ?? "") as Partial<AssistRequest>;
    const t = raw.target;
    if (!t || !TARGET_KINDS.includes(t.kind as TargetKind)) throw new Error("bad target.kind");
    if (typeof t.label !== "string" || t.label.length > 256) throw new Error("bad target.label");
    if (typeof t.artifact !== "string" || t.artifact.length > 128 * 1024) throw new Error("bad target.artifact");
    if ((t as { create?: unknown }).create !== undefined && typeof (t as { create?: unknown }).create !== "boolean") throw new Error("bad target.create");
    if (t.openRef !== undefined) {
      const r = t.openRef as { scope?: unknown; dir?: unknown; file?: unknown };
      const okSkill = (r.scope === "agent" || r.scope === "global") && typeof r.dir === "string";
      const okWs = typeof r.file === "string";
      if (!r || !(okSkill || okWs)) throw new Error("bad target.openRef");
    }
    if (raw.resolved !== undefined) {
      if (!Array.isArray(raw.resolved) || raw.resolved.length > 40) throw new Error("bad resolved");
      for (const e of raw.resolved) {
        if (typeof e?.summary !== "string" || (e.status !== "confirmed" && e.status !== "discarded")) throw new Error("bad resolved entry");
      }
    }
    if (raw.provider !== undefined && (typeof raw.provider !== "string" || raw.provider.length > 64)) throw new Error("bad provider");
    if (raw.model !== undefined && (typeof raw.model !== "string" || raw.model.length > 128)) throw new Error("bad model");
    if (raw.thinkingLevel !== undefined && !["off", "low", "medium", "high"].includes(raw.thinkingLevel as string)) throw new Error("bad thinkingLevel");
    if (raw.memoryPack !== undefined && typeof raw.memoryPack !== "boolean") throw new Error("bad memoryPack");
    if (raw.staged !== undefined) {
      if (!Array.isArray(raw.staged) || raw.staged.length > 30) throw new Error("bad staged");
      for (const s of raw.staged) if (typeof s !== "string" || s.length > 300) throw new Error("bad staged entry");
    }
    const hasMessage = typeof raw.message === "string" && raw.message.trim().length > 0;
    if (hasMessage) {
      if ((raw.message as string).length > 32 * 1024) throw new Error("bad message");
    } else {
      // Legacy whole-conversation shape — the new turn is its last user entry.
      const msgs = Array.isArray(raw.messages) ? raw.messages : [];
      if (msgs.length === 0 || msgs.length > 40) throw new Error("bad messages");
      for (const m of msgs) {
        if ((m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string" || m.text.length > 32 * 1024) {
          throw new Error("bad message entry");
        }
      }
    }
    req = raw as AssistRequest;
  } catch (e) {
    return fail(`Invalid assist request: ${e instanceof Error ? e.message : e}`);
  }

  // The new user turn (message preferred; else the legacy array's last user text).
  const newUserText = (typeof req.message === "string" && req.message.trim())
    ? req.message
    : ([...(req.messages ?? [])].reverse().find((m) => m.role === "user")?.text ?? "");
  if (!newUserText.trim()) return fail("Empty assist message");

  // ── Staged changeset: full-content file revisions reviewed as diffs ──────
  // propose_edit covers the OPEN artifact (any kind); stage_skill_edit (skill
  // page only) stages OTHER skill files / new ones — the multi-file surface.
  // Both write into `staged` (keyed, so a re-stage replaces) and ride back in
  // assist_done.changeset. Nothing touches disk here — accept does, client-side.
  const staged = new Map<string, StagedFile>();
  const MAX_CONTENT = 128 * 1024;
  const clampNote = (n: unknown): string | undefined => (typeof n === "string" ? n.slice(0, 300) : undefined);

  const createMode = req.target.create === true;
  // propose_edit revises the OPEN artifact — skipped in creation mode (nothing
  // is open; its diff would have nowhere to render). Creation routes to
  // stage_skill_edit / cron_jobs create below.
  const pseudoTools: PseudoTool[] = [];
  if (!createMode) pseudoTools.push(
    {
      def: {
        name: "propose_edit",
        description:
          "Stage a revision of the OPEN artifact (the one in the editor) for the user to review as a diff. Pass the COMPLETE revised content, top to bottom — reproduce the ENTIRE artifact and change ONLY what was asked. Never send a fragment or patch, and never drop, shorten, or omit a section you weren't asked to remove (an accidentally dropped section shows up as a deletion the user has to catch). Explain your change in one line.",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "The full revised artifact content" },
            note: { type: "string", description: "One line: what changed and why" },
          },
          required: ["content"],
        },
      },
      handle: (input) => {
        if (typeof input.content !== "string" || input.content.length === 0) {
          return { result: "propose_edit needs non-empty `content` (the full revised artifact).", isError: true };
        }
        if (input.content.length > MAX_CONTENT) {
          return { result: "Proposed content too large (128KB cap).", isError: true };
        }
        staged.set("open", {
          id: "open", label: req.target.label, kind: "open",
          baseline: req.target.artifact, content: input.content, note: clampNote(input.note),
        });
        return { result: "Staged the open file for review (accept/discard). Don't repeat the content in chat." };
      },
    },
  );

  if (req.target.kind === "skill") {
    pseudoTools.push({
      def: {
        name: "stage_skill_edit",
        description:
          "Stage a full-content revision of ANOTHER skill file (NOT the one open in the editor — use propose_edit for that), or CREATE a new skill, for the user to review as its own diff. One call per file; call again to revise it. Read a skill first if you're changing it.",
        inputSchema: {
          type: "object",
          properties: {
            scope: { type: "string", enum: ["agent", "global"], description: "agent = this agent's workspace skills; global = shared skills" },
            dir: { type: "string", description: "The skill's directory name (its on-disk id). A name that doesn't exist yet creates a new skill." },
            content: { type: "string", description: "The COMPLETE SKILL.md — frontmatter included. MUST have a `description:` or the skill is invisible to discovery." },
            note: { type: "string", description: "One line: what changed and why" },
          },
          required: ["scope", "dir", "content"],
        },
      },
      handle: (input) => {
        const scope = input.scope === "global" ? "global" : input.scope === "agent" ? "agent" : null;
        const dir = typeof input.dir === "string" ? input.dir.trim() : "";
        const content = typeof input.content === "string" ? input.content : "";
        if (!scope) return { result: "stage_skill_edit needs scope 'agent' or 'global'.", isError: true };
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(dir)) return { result: "Invalid skill dir — alphanumeric with - or _ only (no spaces/dots/slashes).", isError: true };
        if (!content) return { result: "stage_skill_edit needs the full SKILL.md `content`.", isError: true };
        if (content.length > MAX_CONTENT) return { result: "Content too large (128KB cap).", isError: true };
        if (!parseFrontmatter(content).frontmatter.description) {
          return { result: "That SKILL.md has no `description:` in its frontmatter — discovery would silently skip it. Add one and re-stage.", isError: true };
        }
        // The OPEN skill belongs to propose_edit (baseline = the editor buffer);
        // if they aim here at it, fold into "open" so the diff matches the screen.
        const open = req.target.openRef;
        if (open && open.scope === scope && open.dir === dir) {
          staged.set("open", { id: "open", label: req.target.label, kind: "open", baseline: req.target.artifact, content, note: clampNote(input.note) });
          return { result: "Staged the open skill for review (accept/discard)." };
        }
        const { baseline, isNew } = readSkillBaseline(config, agent, scope, dir);
        staged.set(`skill:${scope}:${dir}`, {
          id: `skill:${scope}:${dir}`,
          label: `${scope}/${dir}/SKILL.md${isNew ? " · new" : ""}`,
          kind: "skill", scope, dir, isNew, baseline, content, note: clampNote(input.note),
        });
        return { result: `Staged ${isNew ? "new skill" : "skill"} ${scope}/${dir} for review (accept/discard).` };
      },
    });
  }

  if (req.target.kind === "workspace") {
    pseudoTools.push({
      def: {
        name: "stage_workspace_edit",
        description:
          "Stage a full-content revision of ANOTHER personality file (NOT the one open in the editor — use propose_edit for that), or fill a MISSING one, for the user to review as its own diff. One call per file; call again to revise it. Read the file first if you're changing it. Allowed: AGENTS.md, IDENTITY.md, SOUL.md, USER.md, MEMORY.md, CALL.md.",
        inputSchema: {
          type: "object",
          properties: {
            file: { type: "string", description: "The personality file (e.g. SOUL.md). One of AGENTS.md/IDENTITY.md/SOUL.md/USER.md/MEMORY.md/CALL.md." },
            content: { type: "string", description: "The COMPLETE file content, top to bottom." },
            note: { type: "string", description: "One line: what changed and why" },
          },
          required: ["file", "content"],
        },
      },
      handle: (input) => {
        const file = typeof input.file === "string" ? input.file.trim() : "";
        const content = typeof input.content === "string" ? input.content : "";
        if (!isPersonalityFile(file)) return { result: `stage_workspace_edit needs a valid file: ${PERSONALITY_FILES.join(", ")}.`, isError: true };
        if (!content) return { result: "stage_workspace_edit needs the full file `content`.", isError: true };
        if (content.length > MAX_CONTENT) return { result: "Content too large (128KB cap).", isError: true };
        // An edit aimed at the OPEN file folds into "open" (baseline = the editor
        // buffer in `artifact`, not stale disk) so the diff matches the screen.
        const open = req.target.openRef;
        if (open && open.file === file) {
          staged.set("open", { id: "open", label: req.target.label, kind: "open", baseline: req.target.artifact, content, note: clampNote(input.note) });
          return { result: "Staged the open file for review (accept/discard)." };
        }
        const filePath = resolve(agent.workspace, file);
        let baseline = "";
        let isNew = true;
        try {
          if (existsSync(filePath)) { baseline = readFileSync(filePath, "utf-8"); isNew = false; }
        } catch { /* unreadable → treat as new */ }
        staged.set(`ws:${file}`, {
          id: `ws:${file}`,
          label: `${file}${isNew ? " · new" : ""}`,
          kind: "workspace", file, isNew, baseline, content, note: clampNote(input.note),
        });
        return { result: `Staged ${isNew ? "new " : ""}${file} for review (accept/discard).` };
      },
    });
  }

  // ── Staged systems actions: structured mutations the user confirms ───────
  // Read actions (list/history/analyze/run) pass straight through to the real
  // tool; create/update/delete are STAGED as confirm cards. Confirm executes the
  // same tool via POST /api/assist/action. (Auto-approve + more domains: later.)
  const pendingActions: StagedAction[] = [];
  let actionSeq = 0;

  if (req.target.kind === "cron" && registry.has("cron_jobs")) {
    const cronDef = registry.get("cron_jobs");
    const DIRECT = new Set(["list", "history", "analyze", "run"]);
    const cronCtx = { agentId: agent.id, sessionId: "assist", workspacePath: agent.workspace };
    pseudoTools.push({
      def: {
        name: "cron_jobs",
        description: `${cronDef?.description ?? "Manage scheduled jobs."}\n\nIN THIS PANEL: list/history/analyze/run run immediately; create/update/delete are STAGED for the user to confirm — they have NOT happened until the user accepts the card. Don't claim a job was created/changed; say you've staged it.`,
        inputSchema: cronDef?.inputSchema ?? { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
      },
      handle: async (input) => {
        const action = String(input.action ?? "");
        if (DIRECT.has(action)) {
          const r = await registry.execute("cron_jobs", input, cronCtx);
          return { result: r.content, isError: r.isError };
        }
        if (action === "create" || action === "update" || action === "delete") {
          const key = `cron.${action}`;
          // Trust dial: if the user pre-approved this action for this agent, run
          // it now and report the real outcome; otherwise stage a confirm card.
          if ((agent.assist?.autoApprove ?? []).includes(key)) {
            const r = await registry.execute("cron_jobs", input, cronCtx);
            return { result: `(auto-approved by the user's trust settings) ${r.content}`, isError: r.isError };
          }
          pendingActions.push({ id: `act:${actionSeq++}`, kind: key, summary: summarizeCronAction(action, input), params: input });
          return { result: "Staged for the user's confirmation (pending) — it has NOT run yet. Keep going; you'll learn the outcome on your next reply." };
        }
        return { result: `Unknown cron action: ${action}`, isError: true };
      },
    });
  }

  if (req.target.kind === "skill" && registry.has("skills_manage")) {
    const def = registry.get("skills_manage");
    const skillCtx = { agentId: agent.id, sessionId: "assist", workspacePath: agent.workspace };
    pseudoTools.push({
      def: {
        name: "skills_manage",
        description: `${def?.description ?? "Manage skills."}\n\nIN THIS PANEL: list runs immediately; delete/enable/disable are STAGED for the user to confirm. To edit a skill's CONTENT use stage_skill_edit, not this.`,
        inputSchema: def?.inputSchema ?? { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
      },
      handle: async (input) => {
        const action = String(input.action ?? "");
        if (action === "list") {
          const r = await registry.execute("skills_manage", input, skillCtx);
          return { result: r.content, isError: r.isError };
        }
        if (action === "delete" || action === "enable" || action === "disable") {
          const key = `skill.${action}`;
          if ((agent.assist?.autoApprove ?? []).includes(key)) {
            const r = await registry.execute("skills_manage", input, skillCtx);
            return { result: `(auto-approved by the user's trust settings) ${r.content}`, isError: r.isError };
          }
          pendingActions.push({ id: `act:${actionSeq++}`, kind: key, summary: summarizeSkillAction(action, input), params: input });
          return { result: "Staged for the user's confirmation (pending) — not done yet. You'll learn the outcome next reply." };
        }
        return { result: `Unknown skills action: ${action}`, isError: true };
      },
    });
  }

  // Don't trample a live chat turn — assist waits briefly, then reports busy.
  const sessionsDir = resolve(config.basePath, ".mantle", "sessions", agent.id);
  const locked = await withAgentLock(
    agent.id,
    { owner: "background", policy: "wait", waitMs: 5_000 },
    async (controller) => {
      {
        // The conversation is a REAL hidden session (isAssist). Flag it on
        // first use so the sidebar filter catches it before any message lands,
        // then append ONLY the new user turn — the session is the source of
        // truth, persisted across refresh/restart.
        SessionManager.createSessionMeta(ASSIST_SESSION_ID, sessionsDir, {
          isAssist: true,
          title: "Systems assist",
        });
        const session = new SessionManager(ASSIST_SESSION_ID, sessionsDir);
        await session.appendMessage({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          role: "user",
          content: [{ type: "text", text: newUserText }],
          // Stamp what was open so the dock can show a per-turn context chip
          // that survives reload (the agent already gets it via the prompt).
          assistContext: { kind: req.target.kind, label: req.target.label, ...(req.target.create ? { create: true } : {}) },
        });

        // Inference selection mirrored from the chat (shared prefs). Override
        // the agent default provider/model only when the client sent them.
        const providerSel = (req.provider || req.model)
          ? {
              ...(req.provider ? { agentDefaultProvider: req.provider } : {}),
              ...(req.model ? { agentDefaultModel: req.model } : {}),
            }
          : undefined;

        // Resolve the backend for compaction + the gauge (the front door
        // re-resolves the same selection for the turn itself). Compact the
        // continuous thread before inference, same as chat, so it can't
        // overflow the window.
        const resolvedTurn = resolveProviderTurn(config, deps, {
          agentDefaultProvider: agent.defaultProvider,
          agentDefaultModel: agent.defaultModel,
          globalDefaultProvider: config.defaultProvider,
          ...providerSel,
        });
        let assistWindow: number | undefined;
        let assistThreshold: number | undefined;
        if (resolvedTurn.ok) {
          assistWindow = resolveContextWindow(resolvedTurn.provider.name, resolvedTurn.model, config);
          assistThreshold = effectiveCompactionThreshold(assistWindow, config);
          await compactIfNeeded({
            session,
            provider: resolvedTurn.provider,
            model: resolvedTurn.model,
            threshold: assistThreshold,
            signal: controller.signal,
          });
        }

        // ── Per-kind context: builder skill + (skills) orientation/read tools ─
        const kind = req.target.kind;
        const guide = loadBuilderSkill(config.basePath, kind) ?? CRIB[kind];
        const skillsMap = kind === "skill" ? buildSkillsMap(config, agent, req.target.label) : "";
        const readGuidance =
          " You have the agent's normal toolset here — workspace file reads (read_file/list_directory/glob_files/grep_files), web_fetch and any web-search tools, memory recall, and session history — so ground a change in what's actually there (AGENTS.md, MEMORY.md, other config, the web, past sessions) before proposing it. The one thing you can't do is touch disk or run shell directly: every file change rides propose_edit / stage_* as a diff the user reviews.";
        const skillEditGuidance = kind === "skill"
          ? " Read other skills (listed above) before changing them. Edit the OPEN skill with propose_edit; edit ANOTHER skill, or create a new one, with stage_skill_edit(scope, dir) — each staged file is reviewed as its own diff. Delete/enable/disable a skill with skills_manage (those stage a confirm card)."
          : "";
        const cronGuidance = kind === "cron" && registry.has("cron_jobs")
          ? " You have the cron_jobs tool — list/history to inspect jobs, run to test one; create/update/delete STAGE a confirm card and do NOT run until the user accepts. Edit the OPEN job's prompt/spec text with propose_edit."
          : "";
        const wsGuidance = kind === "workspace"
          ? " These are the agent's OWN persona/identity files — co-author them: propose changes and let the user ratify, never overwrite wholesale. Edit the OPEN file with propose_edit; edit ANOTHER personality file, or create a missing one, with stage_workspace_edit(file). Read the related files (AGENTS/IDENTITY/SOUL/USER/MEMORY/CALL) first so they stay consistent — keep SOUL.md and CALL.md sounding like the same character."
          : "";
        // Creation mode: nothing is open. propose_edit is unavailable; route the
        // agent to the right creation tool and frame the prompt accordingly.
        const createGuide = !createMode ? ""
          : kind === "skill"
            ? " Nothing is open. To CREATE a skill, call stage_skill_edit(scope, dir) with a NEW dir and the COMPLETE SKILL.md — it stages as a reviewable file. Ask what the skill should do first if it's unclear."
            : kind === "cron"
              ? " Nothing is open. To CREATE a job, call cron_jobs with action \"create\" — it stages a confirm card. Nail down the schedule, what it should do, and delivery first."
              : "";
        const openBlock = createMode
          ? `\n\n## Nothing open — creation mode\nThe user hasn't selected anything; help them create a new ${kind === "cron" ? "job" : "skill"} from scratch.${createGuide}`
          : `\n\n## Open artifact (${req.target.label})\n\`\`\`\n${req.target.artifact}\n\`\`\``;
        const editLine = createMode
          ? " Use the creation tool above; nothing is saved until the user accepts."
          : " When the open artifact needs changing, call propose_edit ONCE with the COMPLETE revised content; the user reviews it as a diff. Small questions deserve plain answers without a proposal.";
        // Resolutions of earlier staged actions, folded in so the agent learns
        // the outcome and acknowledges without re-proposing.
        const ledger = (req.resolved && req.resolved.length > 0)
          ? `\n\n## Actions resolved since your last message\n${req.resolved.map((r) => `- ${r.status === "confirmed" ? "✓ confirmed" : "✗ discarded"}: ${r.summary}${r.outcome ? ` — ${r.outcome}` : ""}`).join("\n")}\nAcknowledge these briefly; don't re-propose them.`
          : "";
        // Pending staged work the user hasn't resolved yet — re-fed every turn so
        // the agent's awareness survives a conversation clear / page refresh (the
        // client persists the diffs/cards; this keeps the model in sync).
        const stagedBlock = (req.staged && req.staged.length > 0)
          ? `\n\n## Currently staged, awaiting the user's decision\n${req.staged.map((s) => `- ${s}`).join("\n")}\nThese are NOT applied yet — don't re-stage or re-propose them, just treat them as already pending. Read a file directly if you need the full detail.`
          : "";
        const maxIters = 8;

        // Memory pack — mirror the chat toggle. Built pre-turn against the new
        // user turn; englyph_* calls bypass the assist tool surface (same as
        // chat's pack), and buildMemoryPack is self-budgeted + best-effort.
        const memoryPack = req.memoryPack === true && registry.has("englyph_search_batch")
          ? await buildMemoryPack(registry, newUserText, agent.id, undefined, controller.signal)
          : undefined;

        // The final turn's prompt size → the dock's context gauge (captured
        // from message_end below, fed into assist_done).
        let finalUsage: TokenUsage | undefined;
        // Tracks an open thinking span so the dock shows one "thinking…" pulse
        // (not one per thinking_delta).
        let thinkingActive = false;

        const turn = await runTriggeredAgentTurn({
          config,
          registry,
          deps,
          agentId: agent.id,
          session,
          signal: controller.signal,
          providerSelection: providerSel,
          promptExtras: memoryPack ? { memoryPack } : undefined,
          // Builder skill carries the craft; the chat skill catalog stays out.
          includeSkills: false,
          // Assist inherits chat's surface (deny-list) MINUS the withheld set
          // above — so web/memory/sessions/file-reads are all in, while the
          // disk/shell writers stay out and cron/skills ride as staged pseudo-
          // tools (which shadow their registry twins on the relevant page).
          toolFilter: (defs) => defs.filter(
            (t) => !chatToolHidden(t.name, process.env.MANTLE_DISABLE_MEMORY_TOOLS === "1")
              && !ASSIST_WITHHELD_TOOLS.has(t.name),
          ),
          pseudoTools,
          maxIterations: maxIters,
          thinkingLevel: req.thinkingLevel ?? "off",
          composeSystemPrompt: (base) => ({
            ...base,
            dynamic:
              base.dynamic +
              `\n\n# Deck assist\nYou are embedded on the ${kind} page of MANTLE's systems deck, helping the user with what they have open.${openBlock}` +
              (skillsMap ? `\n\n${skillsMap}` : "") +
              `\n\n${guide}\n\n## How to help\nBe concise and concrete — this is a side panel, not an essay.${readGuidance}${skillEditGuidance}${cronGuidance}${wsGuidance}${editLine}` +
              stagedBlock + ledger,
          }),
          onEvent: (event) => {
            // Surface the agent's work live so the dock shows what it's reading
            // and staging instead of a dead wait (the "live activity feed").
            switch (event.type) {
              case "text_delta":
                if (typeof event.text === "string") send({ type: "assist_delta", assistId, text: event.text });
                break;
              case "thinking_delta":
                if (!thinkingActive) { thinkingActive = true; send({ type: "assist_thinking", assistId, phase: "start" }); }
                break;
              case "thinking_end":
                if (thinkingActive) { thinkingActive = false; send({ type: "assist_thinking", assistId, phase: "end" }); }
                break;
              case "tool_call_start":
                send({ type: "assist_tool", assistId, phase: "start", toolId: event.id, name: event.name });
                break;
              case "tool_call_executing":
                send({ type: "assist_tool", assistId, phase: "exec", toolId: event.id, label: event.label });
                break;
              case "tool_call_result":
                send({ type: "assist_tool", assistId, phase: "done", toolId: event.id, isError: event.isError, tag: event.tag });
                break;
              case "message_end":
                finalUsage = event.usage;
                break;
            }
          },
        });

        if (!turn.ok) return fail(turn.error);
        const oc = turn.outcome;
        if (oc.stopCause !== "completed" && oc.landed !== true) {
          return fail(oc.error ?? `Turn ended without completing (${oc.stopCause})`);
        }
        send({
          type: "assist_done",
          assistId,
          changeset: [...staged.values()],
          actions: pendingActions,
          // Context usage for the dock gauge — contextTokens is provider-correct
          // (Claude's is cache-inclusive); window + threshold are for the model
          // that ran (local ctx×0.7 cap folded into the threshold).
          ...(finalUsage
            ? { usage: { contextTokens: finalUsage.contextTokens ?? finalUsage.inputTokens, inputTokens: finalUsage.inputTokens, outputTokens: finalUsage.outputTokens } }
            : {}),
          ...(assistWindow ? { contextWindow: assistWindow } : {}),
          ...(assistThreshold ? { compactionThreshold: assistThreshold } : {}),
        });
      }
    },
  );

  if (!locked.ok) {
    fail("Agent is busy with another turn — try again in a moment.");
  }
}

// Project the persisted assist transcript to the dock's {role,text} shape:
// user/assistant turns with real text only. tool_use / tool_result turns carry
// no text and are skipped — matching the dock, which pops empty bubbles, so a
// changeset-only turn (propose_edit and nothing else) leaves no orphan row on
// reload. Exported for the round-trip test.
export function projectAssistConversation(
  messages: SessionMessage[],
): Array<{ role: "user" | "assistant"; text: string; context?: { kind: string; label: string; create?: boolean } }> {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      text: m.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join(""),
      // The per-turn context chip rides user messages (set by handleAssist).
      ...(m.role === "user" && m.assistContext ? { context: m.assistContext } : {}),
    }))
    .filter((m) => m.text.trim().length > 0);
}

// ── REST: load / clear the hidden assist session ─────────────────────────────
// The conversation is the real per-agent `assist` session. The dock fetches it
// on mount (GET) and the ↺ button clears it (DELETE). Returns null when the
// path isn't ours so api.ts's delegation chain falls through.
export async function handleAssistRest(
  req: Request,
  url: URL,
  config: MantleConfig,
): Promise<Response | null> {
  const m = url.pathname.match(/^\/api\/agents\/([\w-]+)\/assist\/session$/);
  if (!m) return null;
  const agent = getAgent(config, m[1]);
  if (!agent) return json({ error: `Unknown agent: ${m[1]}` }, 404);
  const sessionsDir = resolve(config.basePath, ".mantle", "sessions", agent.id);

  if (req.method === "GET") {
    const session = new SessionManager(ASSIST_SESSION_ID, sessionsDir);
    return json({ messages: projectAssistConversation(await session.getMessages()) });
  }

  if (req.method === "DELETE") {
    // Serialize with any in-flight assist turn (which holds the agent lock) so
    // the wipe can't tear the JSONL mid-append; best-effort if it can't grab it.
    const locked = await withAgentLock(
      agent.id,
      { owner: "background", policy: "wait", waitMs: 2_000 },
      async () => { SessionManager.deleteSession(ASSIST_SESSION_ID, sessionsDir); },
    );
    if (!locked.ok) SessionManager.deleteSession(ASSIST_SESSION_ID, sessionsDir);
    return json({ ok: true });
  }

  return null;
}
