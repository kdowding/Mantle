// Session sidebar actions — list / select (replay) / new / delete. The runes
// replacement for app.js loadSessions / selectSession / createNewSession /
// deleteSession.
import { ui, chat, sessions, composer, usage, resetChat, type ChatMessage } from './state.svelte';
import { getSessions, getTranscript, deleteSession as apiDeleteSession, patchSession } from './api';
import { buildTranscript } from './transcript';
import { loadSessionPersona } from './personas.svelte';
import { resetTurn, createIsland, type Island } from './stream';
import { resetThinking } from './reasoning';
import { seenBuilt, markSeenBuilt, markSeenCount } from './unread';

// ── Session-entrance choreography (the task-panel materialize) ──────────────
// The last K messages of a loaded transcript land MINIMIZED (title bar only),
// window-restore open at staggered slots, and assistant text TYPES out — each
// text part runs its own reveal island fed the full content (the clock's
// catch-up pacing reveals any length in ~0.85s). The view stays bottom-pinned
// through it via the islands' global write hook. Everything above the tail
// renders instantly.
const ENTRANCE_COUNT = 6;
// (The 55ms pop ripple lives in Message.svelte's ent-pop animation delay.)
const ENTRANCE_TYPE_AT_MS = 200; // ALL typewriters fire together, post-ripple
const ENTRANCE_TYPE_SEC = 0.3; // each message types linearly in ~this long

interface ArmedPart {
  msgId: string;
  partId: string;
  island: Island;
  text: string;
  order: number;
}

// Phase 1 — BEFORE chat.messages is assigned: swap each tail text part onto
// a reveal island (StreamingText reads text/island at MOUNT, so this must
// happen pre-render). Returns the armed list for phase 2.
function armEntrance(msgs: ChatMessage[]): ArmedPart[] {
  if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) return [];
  const armed: ArmedPart[] = [];
  const tail = msgs.filter((m) => !m.divider).slice(-ENTRANCE_COUNT);
  tail.forEach((m, order) => {
    m.entranceOrder = order;
    if (m.role !== 'assistant') return;
    for (const p of m.parts) {
      if (p.kind !== 'text' || !p.text) continue;
      // Linear pacing: constant velocity sized to finish in ENTRANCE_TYPE_SEC
      // — the adaptive clock's remaining-proportional drain decays toward
      // the end (every bubble's last line crawled).
      const island = createIsland({ fixedCps: Math.max(40, p.text.length / ENTRANCE_TYPE_SEC) });
      armed.push({ msgId: m.id, partId: p.id, island, text: p.text, order });
      p.island = island;
      p.raw = p.text; // copy / voice-replay keep reading the source
      p.ghost = p.text; // hidden sizing layer — final height from frame one
      // Keep p.text as the DURABLE source: StreamingText animates the island
      // only on the entrance's FIRST mount (the `entrance` flag) and renders
      // p.text statically on any remount — so a stage-swap back to chat can't
      // leave the spent island's bubble blank.
      p.active = true; // cursor blinks while it types
    }
  });
  return armed;
}

// Phase 2 — AFTER assignment: wire completions through the PROXIED parts
// (writes to the raw pre-proxy objects never reach Svelte's signals — found
// live as cursors stuck blinking forever) and schedule the staggered feeds.
function runEntrance(armed: ArmedPart[], sid: string): void {
  for (const a of armed) {
    const part = chat.messages.find((m) => m.id === a.msgId)?.parts.find((p) => p.id === a.partId);
    if (part && part.kind === 'text') a.island.setOnDone(() => { part.active = false; });
    setTimeout(() => {
      if (chat.sessionId !== sid) return; // switched away mid-entrance
      a.island.push(a.text);
      a.island.end();
    }, ENTRANCE_TYPE_AT_MS); // simultaneous — the panel materializes as ONE event
  }
}

// Fetch the current agent's chat sessions for the sidebar. Cron/assist
// sessions are filtered out (their own rooms own them). Guarded against an
// agent switch landing mid-fetch.
export async function loadSessions(): Promise<void> {
  const agentId = ui.currentAgentId;
  if (!agentId) { sessions.list = []; return; }
  try {
    const { sessions: list } = await getSessions(agentId);
    if (ui.currentAgentId !== agentId) return; // superseded
    sessions.list = (list ?? []).filter((s) => !s.isCron && !s.isAssist);
  } catch {
    if (ui.currentAgentId !== agentId) return;
    sessions.list = [];
  }
}

// Load a past session's transcript into the chat view.
export async function selectSession(id: string): Promise<void> {
  const agentId = ui.currentAgentId;
  if (!agentId) return;
  ui.deckTab = null; // picking a session lands you in the conversation
  resetTurn();
  resetThinking();
  chat.isStreaming = false;
  chat.sessionId = id;
  chat.messages = [];
  usage.contextTokens = 0; // stale gauge never carries into the new session
  usage.contextWindow = null;
  usage.compactionThreshold = null;
  // An armed edit never crosses sessions — left set, the next send here would
  // carry edit:true and the server would drop THIS session's last user turn.
  composer.editPending = false;
  void loadSessionPersona(); // the session's own persona overrides the agent default
  try {
    const raw = await getTranscript(id);
    if (ui.currentAgentId !== agentId || chat.sessionId !== id) return; // superseded
    const msgs = buildTranscript(raw, agentId, id);
    const armed = armEntrance(msgs); // pre-assignment: mount-time props
    // "— new since you left —" seam: the stored built-length from the last
    // visit marks where this browser stopped reading.
    const seen = seenBuilt(id);
    if (seen != null && seen > 0 && seen < msgs.length) {
      const divider: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'system',
        text: '',
        parts: [],
        tools: [],
        toolsOpen: false,
        attachments: [],
        streaming: false,
        error: false,
        blank: false,
        divider: true,
      };
      msgs.splice(seen, 0, divider);
    }
    chat.messages = msgs;
    runEntrance(armed, id); // post-assignment: proxied completions + feeds
    // Mark seen — built length EXCLUDES the divider row.
    markSeenBuilt(id, msgs.filter((m) => !m.divider).length);
    markSeenCount(id, sessions.list.find((s) => s.id === id)?.messageCount);
  } catch {
    if (ui.currentAgentId === agentId && chat.sessionId === id) chat.messages = [];
  }
}

// Reset to an empty session (the + button / agent switch). Creation is lazy —
// the next sent message mints the id. Does NOT touch ui.deckTab — agent
// switches route through here and the systems deck follows the agent;
// Sessions' + button exits the deck itself.
export function newSession(): void {
  resetTurn();
  resetThinking();
  resetChat();
}

export async function removeSession(id: string): Promise<void> {
  const agentId = ui.currentAgentId;
  if (!agentId) return;
  try {
    await apiDeleteSession(agentId, id);
  } catch {
    return;
  }
  if (chat.sessionId === id) newSession();
  await loadSessions();
}

// Rename / pin — PATCH the server, then sync the list item in place (no
// full reload; the sidebar keeps its scroll position).
export async function renameSession(id: string, title: string): Promise<void> {
  const agentId = ui.currentAgentId;
  const trimmed = title.trim();
  if (!agentId || !trimmed) return;
  try {
    const updated = await patchSession(agentId, id, { title: trimmed });
    const item = sessions.list.find((s) => s.id === id);
    if (item) item.title = updated.title;
  } catch { /* keep the old title on failure */ }
}

export async function setSessionPinned(id: string, pinned: boolean): Promise<void> {
  const agentId = ui.currentAgentId;
  if (!agentId) return;
  try {
    await patchSession(agentId, id, { pinned });
    const item = sessions.list.find((s) => s.id === id);
    if (item) item.pinned = pinned || undefined;
  } catch { /* leave as-is on failure */ }
}
