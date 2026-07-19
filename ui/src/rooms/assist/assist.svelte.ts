// Assist room — the agent embedded on the systems-deck pages. Each deck tab
// registers its open artifact as the TARGET (content getter + apply-back, and
// for skills an external writer for OTHER files); the dock chats over WS
// (assist_message → assist_delta/assist_done) and stages the agent's edits as a
// CHANGESET of diffs the user accepts/discards per file (or all at once). Open
// file → editor buffer (you save); other skill files → written via applyExternal.
import { untrack } from 'svelte';
import { ui, prefs } from '../../lib/state.svelte';
import { backendById } from '../../lib/inference';
import { onWsEvent, sendWs, type WsEvent } from '../../lib/ws';
import { segmentDiff, reconstructContent, collapseContext } from '../../lib/diff';
// The diff engine now lives in lib/diff (pure, so the systems decks can render
// it without importing this room). Re-export the bits the dock pulls from here
// so its import line stays unchanged.
export { segmentDiff, collapseContext };

export interface AssistTarget {
  kind: 'skill' | 'cron' | 'workspace';
  label: string;
  getContent: () => string;
  apply: (content: string) => void;
  // Creation mode: nothing is open in the editor (no skill selected / no cron
  // draft). The dock stays USABLE so the user can ask the agent to create one —
  // the server drops propose_edit (no open artifact) and routes creation to
  // stage_skill_edit (skills) / cron_jobs create (cron).
  create?: boolean;
  // skill kind: the open skill's on-disk identity, so the agent's edits aimed at
  // the open file fold into the "open" (buffer-baselined) entry, not a stale disk
  // one.
  // skill kind: { scope, dir }; workspace kind: { file }.
  ref?: { scope: 'agent' | 'global'; dir: string } | { file: string };
  // Persist a NON-open staged file the agent staged (accept → disk via the
  // room's API + list refresh). skill: { scope, dir }; workspace: { file }.
  // Absent ⇒ only the open file is editable.
  applyExternal?: (
    ref: { scope: 'agent' | 'global'; dir: string; isNew?: boolean } | { file: string; isNew?: boolean },
    content: string,
  ) => Promise<void>;
}

// One reviewable file in the staged changeset (mirrors the server shape).
export interface StagedFile {
  id: string;                 // "open" | `skill:${scope}:${dir}` | `ws:${file}`
  label: string;
  kind: 'open' | 'skill' | 'workspace';
  scope?: 'agent' | 'global';
  dir?: string;
  file?: string;              // workspace kind: the personality filename
  isNew?: boolean;
  baseline: string;
  content: string;
  note?: string;
}

// A structured systems action the agent staged, awaiting confirm/discard.
export interface StagedAction {
  id: string;          // client-assigned (server ids aren't unique across turns)
  kind: string;        // e.g. "cron.create"
  summary: string;
  params: Record<string, unknown>;
}

// A resolved action, fed back into the next turn's context so the agent learns
// the outcome and acknowledges it.
export interface ResolvedAction {
  summary: string;
  status: 'confirmed' | 'discarded';
  outcome?: string;
}

// One step in the assistant's live work feed (a tool read/edit). Built from the
// server's assist_tool events so the user watches the agent work instead of a
// dead wait.
export interface AssistActivity {
  toolId: string;
  name?: string;   // tool name (drives the glyph + fallback label)
  label?: string;  // friendly label from the server (toolLabel), when present
  status: 'running' | 'done' | 'error';
}

export interface AssistMsg {
  role: 'user' | 'assistant';
  text: string;
  live?: boolean; // streaming into this row
  // user: the systems artifact open when this turn was sent — the context chip
  // (what the agent saw for this turn). Persisted server-side, so it survives
  // reload.
  context?: { kind: string; label: string; create?: boolean };
  // assistant: the live work feed + a thinking pulse (live-session only).
  activities?: AssistActivity[];
  thinking?: boolean;
  // Animate the entry — set ONLY on messages created this session (a sent turn),
  // never on loaded history, so a reload/agent-switch doesn't replay everything.
  fresh?: boolean;
}

export const assist = $state({
  // Pinned open by default — assist is the systems deck's right-hand companion,
  // not an opt-in panel. The deck header still collapses it.
  open: true,
  target: null as AssistTarget | null,
  msgs: [] as AssistMsg[],
  streaming: false,
  changeset: [] as StagedFile[],
  // Per-file per-hunk accept mask, keyed by file id (parallel to changeset).
  // true = take the change, false = keep the original lines. The OPEN file's
  // hunks are owned by the in-editor InlineDiff, so only OTHER (skill) files
  // populate this map.
  hunks: {} as Record<string, boolean[]>,
  // Pending systems-action confirm cards + the resolution ledger sent next turn.
  actions: [] as StagedAction[],
  actionLog: [] as ResolvedAction[],
  // Bumped after a systems action (cron/skill) is APPLIED, so the
  // matching deck can refresh its list without coupling to assist internals.
  appliedTick: 0,
  error: null as string | null,
  // Loading the persisted conversation from the server (mount / agent switch).
  loading: false,
  // Context gauge for the dock — set from assist_done (the model that ran).
  contextTokens: 0,
  contextWindow: null as number | null,
  compactionThreshold: null as number | null,
});

let clientActionSeq = 0;

let seq = 0;
let activeId: string | null = null;

// ── Persistence (two surfaces, deliberately split) ───────────────────────────
// • The CONVERSATION is a real hidden server session (one per agent), continuous
//   across all four deck pages. Loaded on mount / agent switch via
//   GET …/assist/session; the ↺ button clears it via DELETE. NOT in localStorage
//   — the server owns it, so it survives a cache clear / a different device.
// • The STAGED REVIEW-STATE (pending diffs + confirm cards) is ephemeral UI
//   state scoped to the current (agent, kind) — a staged cron edit is meaningless
//   on the skill page. Persisted to localStorage per (agent, kind) so a
//   refresh OR a page switch-and-back restores the right domain's pending work.
//   (The OLD single global slot + a restore flag is what self-erased on refresh;
//   keying by owner removes the race entirely.) The agent's awareness of pending
//   work rides the per-turn `staged` summary regardless (see sendAssist).
const stagedKey = (agentId: string, kind: AssistTarget['kind']): string =>
  `mantle-assist-staged:${agentId}:${kind}`;

interface StagedSnapshot {
  changeset: StagedFile[];
  hunks: Record<string, boolean[]>;
  actions: StagedAction[];
  actionLog: ResolvedAction[];
}

// Which (agent, kind) the in-memory staged state currently belongs to. The
// persist effect writes ONLY when this matches the live (agent, kind), so the
// window after a switch — before the new slot has loaded — can't clobber it.
let stagedOwner: { agentId: string; kind: AssistTarget['kind'] } | null = null;

function loadStaged(agentId: string, kind: AssistTarget['kind']): void {
  stagedOwner = { agentId, kind };
  try {
    const raw = localStorage.getItem(stagedKey(agentId, kind));
    const s = raw ? (JSON.parse(raw) as StagedSnapshot) : null;
    assist.changeset = s?.changeset ?? [];
    assist.hunks = s?.hunks ?? {};
    assist.actions = s?.actions ?? [];
    assist.actionLog = s?.actionLog ?? [];
  } catch {
    assist.changeset = []; assist.hunks = {}; assist.actions = []; assist.actionLog = [];
  }
}

function writeStaged(): void {
  const agentId = ui.currentAgentId;
  const kind = assist.target?.kind;
  if (!agentId || !kind) return;
  // Skip until the in-memory staged state belongs to the live (agent, kind).
  if (!stagedOwner || stagedOwner.agentId !== agentId || stagedOwner.kind !== kind) return;
  const empty = assist.changeset.length === 0 && assist.actions.length === 0 && assist.actionLog.length === 0;
  try {
    if (empty) { localStorage.removeItem(stagedKey(agentId, kind)); return; }
    const snap: StagedSnapshot = {
      changeset: assist.changeset, hunks: assist.hunks,
      actions: assist.actions, actionLog: assist.actionLog,
    };
    const json = JSON.stringify(snap);
    if (json.length <= 3_000_000) localStorage.setItem(stagedKey(agentId, kind), json);
  } catch { /* quota / unavailable — best effort */ }
}

$effect.root(() => {
  // Swap the staged slot in whenever the live (agent, kind) changes to one this
  // memory doesn't already own. Order-independent with the persist effect below:
  // a not-yet-owned pair makes writeStaged skip, so neither can clobber the other.
  $effect(() => {
    const agentId = ui.currentAgentId;
    const kind = assist.target?.kind;
    if (!agentId || !kind) return;
    if (stagedOwner && stagedOwner.agentId === agentId && stagedOwner.kind === kind) return;
    loadStaged(agentId, kind);
  });
  // Persist on any SETTLED change (skip mid-stream to avoid per-delta writes;
  // the streaming→false flip itself re-triggers, capturing the finished turn).
  $effect(() => {
    if (assist.streaming) return;
    void assist.changeset.length; void assist.actions.length; void assist.actionLog.length;
    void Object.keys(assist.hunks).length; void assist.target?.kind; void ui.currentAgentId;
    writeStaged();
  });
});

// Load the persisted CONVERSATION for an agent (mount / agent switch). The
// staged review-state loads separately (the effect above), so the two surfaces
// never race. Guards against an agent switch landing mid-fetch.
export async function loadAssistSession(agentId: string): Promise<void> {
  assist.msgs = [];
  assist.error = null;
  assist.contextTokens = 0;
  assist.contextWindow = null;
  assist.compactionThreshold = null;
  assist.loading = true;
  try {
    const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/assist/session`);
    const data = (await r.json().catch(() => ({}))) as {
      messages?: Array<{ role: 'user' | 'assistant'; text: string; context?: { kind: string; label: string; create?: boolean } }>;
    };
    if (ui.currentAgentId !== agentId) return; // switched away mid-fetch
    assist.msgs = Array.isArray(data.messages)
      ? data.messages.map((m) => ({ role: m.role, text: m.text, ...(m.context ? { context: m.context } : {}) }))
      : [];
  } catch {
    if (ui.currentAgentId === agentId) assist.msgs = [];
  } finally {
    if (ui.currentAgentId === agentId) assist.loading = false;
  }
}

// Deck tabs call this from an $effect (cleanup passes null). The CONVERSATION is
// continuous across pages, so a kind change no longer wipes it — only the
// domain-scoped staged slot swaps (via the effect above). A same-kind file swap
// (opening another skill / cron job) drops the stale "open" diff, keeping the
// multi-file edits.
// CAUTION: callers are effects — the prior-target comparison must be UNTRACKED or
// the read+write of assist.target loops the calling effect on itself.
export function setAssistTarget(t: AssistTarget | null): void {
  untrack(() => {
    const prev = assist.target;
    const kindChanged = prev?.kind !== t?.kind;
    const labelChanged = prev?.label !== t?.label;
    assist.target = t;
    if (!kindChanged && labelChanged) {
      assist.changeset = assist.changeset.filter((c) => c.id !== 'open');
      delete assist.hunks.open;
    }
  });
}

// The ↺ button — clear the CONVERSATION (the server session) but KEEP pending
// staged changes. Safe because the agent is re-told what's staged every turn
// (the `staged` summary below), so a reset never blinds it to diffs/actions
// sitting in the editor.
export async function clearConversation(): Promise<void> {
  const agentId = ui.currentAgentId;
  assist.msgs = [];
  assist.actionLog = [];
  assist.error = null;
  assist.streaming = false;
  assist.contextTokens = 0;
  assist.contextWindow = null;
  assist.compactionThreshold = null;
  activeId = null;
  if (!agentId) return;
  try {
    await fetch(`/api/agents/${encodeURIComponent(agentId)}/assist/session`, { method: 'DELETE' });
  } catch { /* best-effort — the local view is already cleared */ }
}

export async function sendAssist(text: string): Promise<void> {
  const target = assist.target;
  const agentId = ui.currentAgentId;
  if (!target || !agentId || assist.streaming || !text.trim()) return;
  assist.error = null;
  // Stamp what's open onto the turn — the chip + what the agent receives.
  assist.msgs.push({
    role: 'user',
    text: text.trim(),
    fresh: true,
    context: { kind: target.kind, label: target.label, ...(target.create ? { create: true } : {}) },
  });
  // Inference selection mirrors the chat (shared `prefs`). Only forward a
  // provider/model when the backend is configured; absent ⇒ agent default.
  const b = backendById(prefs.backendId);
  const usableBackend = !!b && b.configured;
  // A one-line-per-item summary of what's currently staged + awaiting the user —
  // re-fed every turn so the agent's awareness of pending work is decoupled from
  // the conversation (survives a ↺ clear and a refresh). Summary only; the agent
  // can read a file directly for full detail.
  const staged = [
    ...assist.changeset.map((f) => f.id === 'open'
      ? `the open ${target.kind === 'cron' ? 'job spec' : 'file'} (${f.label}) — a staged revision awaiting accept/reject`
      : `${f.isNew ? 'new ' : ''}${f.kind === 'workspace' ? 'file' : 'skill'} ${f.label} — staged, awaiting accept/reject`),
    ...assist.actions.map((a) => `${a.kind}: ${a.summary} — awaiting your confirm`),
  ];
  // The request carries the WHOLE conversation (server is stateless); the live
  // row is appended after the payload is built so it stays out of it.
  const payload = {
    target: {
      kind: target.kind,
      label: target.label,
      artifact: target.getContent(),
      ...(target.ref ? { openRef: target.ref } : {}),
      ...(target.create ? { create: true } : {}),
    },
    // Only the NEW turn — the conversation is the persisted server session now.
    message: text.trim(),
    ...(usableBackend && prefs.backendId ? { provider: prefs.backendId } : {}),
    ...(usableBackend && prefs.model ? { model: prefs.model } : {}),
    ...(prefs.thinkingLevel !== 'off' ? { thinkingLevel: prefs.thinkingLevel } : {}),
    memoryPack: prefs.memoryPack,
    ...(staged.length > 0 ? { staged } : {}),
    ...(assist.actionLog.length > 0
      ? { resolved: assist.actionLog.map((r) => ({ summary: r.summary, status: r.status, outcome: r.outcome })) }
      : {}),
  };
  assist.msgs.push({ role: 'assistant', text: '', live: true, fresh: true });
  assist.streaming = true;
  activeId = `a${++seq}-${Date.now().toString(36)}`;
  try {
    await sendWs({
      type: 'assist_message',
      agentId,
      assistId: activeId,
      content: JSON.stringify(payload),
    });
    assist.actionLog = []; // consumed — the agent learns the outcome this turn
  } catch {
    finishLive('Not connected.');
  }
}

function liveRow(): AssistMsg | null {
  const last = assist.msgs[assist.msgs.length - 1];
  return last?.live ? last : null;
}

function finishLive(error?: string): void {
  const row = liveRow();
  if (row) {
    row.live = false;
    row.thinking = false;
    // Drop a bubble that produced nothing the user can see — but KEEP one whose
    // only output was work (e.g. a propose_edit-only turn), so its activity feed
    // ("staged SOUL.md") stays as the record of what happened.
    if (!row.text && !(row.activities && row.activities.length)) assist.msgs.pop();
  }
  assist.streaming = false;
  activeId = null;
  if (error) assist.error = error;
}

// ── Accept / reject staged files + hunks ─────────────────────────────────────
function removeFile(id: string): void {
  assist.changeset = assist.changeset.filter((c) => c.id !== id);
  delete assist.hunks[id];
}

// Flip one hunk of a file between "take the change" and "keep original".
export function toggleHunk(fileId: string, hunkId: number): void {
  const arr = assist.hunks[fileId];
  if (arr && hunkId >= 0 && hunkId < arr.length) arr[hunkId] = !arr[hunkId];
}

// What would be written: baseline with ONLY the accepted hunks applied.
function effectiveContent(f: StagedFile): string {
  const accepted = assist.hunks[f.id];
  if (!accepted) return f.content; // no mask ⇒ whole file accepted
  return reconstructContent(segmentDiff(f.baseline, f.content).segments, accepted);
}

export async function acceptFile(id: string): Promise<void> {
  const f = assist.changeset.find((c) => c.id === id);
  const t = assist.target;
  if (!f || !t) return;
  const content = effectiveContent(f);
  if (content === f.baseline) { removeFile(id); return; } // every hunk rejected ⇒ no-op
  try {
    if (f.kind === 'open') {
      t.apply(content);
    } else if (f.kind === 'workspace' && f.file && t.applyExternal) {
      await t.applyExternal({ file: f.file, isNew: f.isNew }, content);
    } else if (f.scope && f.dir && t.applyExternal) {
      await t.applyExternal({ scope: f.scope, dir: f.dir, isNew: f.isNew }, content);
    } else {
      throw new Error('No writer for this file');
    }
    removeFile(id);
  } catch (e) {
    assist.error = e instanceof Error ? e.message : String(e);
  }
}

export function rejectFile(id: string): void {
  removeFile(id);
}

// ── Confirm / discard a staged systems action ────────────────────────────────
// Confirm runs the real tool server-side (POST /api/assist/action); the outcome
// is logged into the ledger so the agent learns it on the next turn.
export async function confirmAction(id: string): Promise<void> {
  const a = assist.actions.find((x) => x.id === id);
  const agentId = ui.currentAgentId;
  if (!a || !agentId) return;
  try {
    const r = await fetch('/api/assist/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, kind: a.kind, params: a.params }),
    });
    const data = (await r.json().catch(() => ({}))) as { ok?: boolean; outcome?: string; error?: string };
    if (!r.ok || data.ok === false) throw new Error(data.error ?? data.outcome ?? `HTTP ${r.status}`);
    assist.actionLog.push({ summary: a.summary, status: 'confirmed', outcome: data.outcome });
    assist.actions = assist.actions.filter((x) => x.id !== id);
    assist.appliedTick++; // nudge the matching deck to refresh its list
  } catch (e) {
    assist.error = e instanceof Error ? e.message : String(e);
  }
}

export function discardAction(id: string): void {
  const a = assist.actions.find((x) => x.id === id);
  if (a) assist.actionLog.push({ summary: a.summary, status: 'discarded' });
  assist.actions = assist.actions.filter((x) => x.id !== id);
}

// Grant standing trust for this action KIND (per agent) and run it now — the
// Cursor "always allow" move. Future actions of this kind auto-approve server-
// side (no card). File-content edits are never eligible (always reviewed).
export async function alwaysAllowAction(id: string): Promise<void> {
  const a = assist.actions.find((x) => x.id === id);
  const agentId = ui.currentAgentId;
  if (!a || !agentId) return;
  try {
    const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/assist/auto-approve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: a.kind, allowed: true }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    assist.error = e instanceof Error ? e.message : String(e);
    return;
  }
  await confirmAction(id); // run it now too
}

export function registerAssistWs(): () => void {
  return onWsEvent('assist_', (ev: WsEvent) => {
    if (!activeId || ev.assistId !== activeId) return;
    if (ev.type === 'assist_delta') {
      const row = liveRow();
      if (row) row.text += typeof ev.text === 'string' ? ev.text : '';
      return;
    }
    // Live work feed: a thinking pulse + a row per tool the agent runs.
    if (ev.type === 'assist_thinking') {
      const row = liveRow();
      if (row) row.thinking = ev.phase === 'start';
      return;
    }
    if (ev.type === 'assist_tool') {
      const row = liveRow();
      if (!row) return;
      if (!row.activities) row.activities = [];
      const toolId = typeof ev.toolId === 'string' ? ev.toolId : '';
      if (ev.phase === 'start') {
        row.activities.push({ toolId, name: typeof ev.name === 'string' ? ev.name : undefined, status: 'running' });
      } else {
        const a = row.activities.find((x) => x.toolId === toolId);
        if (a) {
          if (ev.phase === 'exec' && typeof ev.label === 'string') a.label = ev.label;
          if (ev.phase === 'done') a.status = ev.isError === true ? 'error' : 'done';
        }
      }
      return;
    }
    if (ev.type === 'assist_done') {
      const err = typeof ev.error === 'string' ? ev.error : undefined;
      const incoming = Array.isArray(ev.changeset) ? (ev.changeset as StagedFile[]) : [];
      if (!err) {
        // Merge by id so a re-staged file replaces its prior entry and new files
        // append — the changeset accumulates across turns until resolved.
        for (const f of incoming) {
          if (!f || typeof f.id !== 'string') continue;
          const i = assist.changeset.findIndex((c) => c.id === f.id);
          if (i >= 0) assist.changeset[i] = f;
          else assist.changeset.push(f);
          // The open file's hunks live in the in-editor InlineDiff (it re-seeds
          // its own decisions on a new proposal); only OTHER files use the dock
          // mask. Fresh mask — a (re)staged file starts all-accepted.
          if (f.id !== 'open') {
            assist.hunks[f.id] = Array.from({ length: segmentDiff(f.baseline, f.content).hunkCount }, () => true);
          }
        }
        // Append staged actions — server ids aren't unique across turns, re-key.
        const incomingActions = Array.isArray(ev.actions) ? (ev.actions as StagedAction[]) : [];
        for (const a of incomingActions) {
          if (!a || typeof a.kind !== 'string') continue;
          assist.actions.push({ id: `ca${clientActionSeq++}`, kind: a.kind, summary: a.summary ?? a.kind, params: a.params ?? {} });
        }
      }
      // Context gauge for the dock — the model that actually ran this turn.
      const u = ev.usage as { contextTokens?: number; inputTokens?: number } | undefined;
      if (u) assist.contextTokens = typeof u.contextTokens === 'number' ? u.contextTokens : (u.inputTokens ?? assist.contextTokens);
      if (typeof ev.contextWindow === 'number') assist.contextWindow = ev.contextWindow;
      if (typeof ev.compactionThreshold === 'number') assist.compactionThreshold = ev.compactionThreshold;
      finishLive(err);
    }
  });
}

// ── The OPEN file (in-editor diff) ───────────────────────────────────────────
// The open artifact's diff renders INSIDE the deck editor (components/InlineDiff),
// not the dock — the Cursor model. The InlineDiff owns the per-hunk decisions and
// reconstructs the final content; on resolve the DECK writes its own buffer (or
// runs applySpec) and calls discardOpen() to clear the staged entry. We keep the
// apply on the deck side (not via target.apply) so a write/parse error surfaces
// in the editor diff, not the dock.
export function openStaged(): StagedFile | null {
  return assist.changeset.find((c) => c.id === 'open') ?? null;
}

// Drop the open file's staged entry (the deck already wrote the buffer).
export function discardOpen(): void {
  removeFile('open'); // removeFile also clears hunks['open']
}

// ── Dock bulk actions (OTHER files only) ─────────────────────────────────────
// The dock owns multi-file (non-open) skill diffs; the editor owns the open
// file. Bulk accept/reject here must NOT touch the open file — that would write
// it behind the user's back, defeating the in-editor flow.
export async function acceptOthers(): Promise<void> {
  // Snapshot ids — acceptFile mutates the changeset as it goes.
  for (const id of assist.changeset.filter((c) => c.id !== 'open').map((c) => c.id)) {
    await acceptFile(id);
  }
}

export function rejectOthers(): void {
  assist.changeset = assist.changeset.filter((c) => c.id === 'open');
  for (const k of Object.keys(assist.hunks)) if (k !== 'open') delete assist.hunks[k];
}
