// WebSocket transport + chat turn pipeline. Owns the socket, sends `message`
// turns, and dispatches inbound AgentStreamEvents into reactive state + the two
// streaming islands (text → lib/stream.ts via smd; reasoning → lib/reasoning.ts).
// Same /ws contract as the vanilla UI.
//
// A turn is an ordered sequence of parts (thinking / text runs) plus tool calls
// collected in a bottom container. Text and tools interleave: a tool finalizes
// the current text run (interrupt), and the next text delta opens a fresh one.
// agent_attachment is deferred to the attachments increment (stubbed below).
import { ui, chat, prefs, usage, composer, getFeature, type ChatMessage, type TextPart, type ThinkingPart, type ToolCall, type Attachment } from './state.svelte';
import { createSession, uploadUrl } from './api';
import { resetTurn, pushDelta, endTurn, interrupt, setOnDone } from './stream';
import { pushThinking, finishThinking, resetThinking } from './reasoning';
import { loadSessions } from './sessions';
import { fastModeAvailable } from './inference';
import { uploadPending, clearPending, kindFromCategory } from './attachments';

// Minimal inbound event shape — the full AgentStreamEvent union lives in the
// backend (src/agent/loop.ts). We read only the fields the chat path needs.
interface ServerEvent {
  type?: string;
  source?: string;
  text?: string;
  error?: string;
  id?: string;
  name?: string;
  input?: unknown;
  startedAt?: number;
  label?: string;
  chunk?: string;
  isError?: boolean;
  result?: string;
  tag?: string;
  reason?: string; // note_rejected
  usage?: { inputTokens?: number; outputTokens?: number; contextTokens?: number; tokensPerSec?: number };
  // message_end gauge bounds for the model that ran (server-resolved).
  contextWindow?: number;
  compactionThreshold?: number;
  attachment?: { fileId?: string; filename?: string; mediaType?: string; size?: number; category?: string };
}

// Inbound event with room-specific fields preserved (rooms read their own).
export type WsEvent = ServerEvent & Record<string, unknown>;

// ── Room-event seam ──────────────────────────────────────────────────────────
// Rooms (channel / music / call / voice …) bolt onto the socket here instead of
// being cases in the chat dispatch below: register with a type prefix (or a
// predicate) and matched events are consumed before the chat path sees them.
// Mirrors the backend's removable-rooms philosophy — porting a room never
// edits core dispatch, and deleting one deletes its registration with it.
type WsMatch = string | ((type: string, ev: WsEvent) => boolean);
const roomHandlers: Array<{ match: WsMatch; handle: (ev: WsEvent) => void; claim: boolean }> = [];

// Returns an unregister function (call it from the room's $effect cleanup or
// teardown). String matches are type prefixes: 'channel' claims 'channel_*'.
// `claim: false` registers an OBSERVER — it sees matched events but they still
// flow to the chat dispatch (e.g. voice watches turn errors to stop audio).
export function onWsEvent(
  match: WsMatch,
  handle: (ev: WsEvent) => void,
  opts: { claim?: boolean } = {},
): () => void {
  const entry = { match, handle, claim: opts.claim !== false };
  roomHandlers.push(entry);
  return () => {
    const i = roomHandlers.indexOf(entry);
    if (i !== -1) roomHandlers.splice(i, 1);
  };
}

function routeToRoom(ev: WsEvent): boolean {
  const type = ev.type ?? '';
  let claimed = false;
  for (const { match, handle, claim } of roomHandlers) {
    const hit = typeof match === 'string' ? type.startsWith(match) : match(type, ev);
    if (hit) {
      if (claim) claimed = true;
      handle(ev);
    }
  }
  return claimed;
}

// ── Turn-option seam ─────────────────────────────────────────────────────────
// Rooms decorate outbound turn payloads (message/retry) without core knowing
// them — the voice room adds voiceMode/voiceProvider while its toggle is on.
const turnOptionDecorators: Array<(payload: Record<string, unknown>) => void> = [];

export function onTurnOptions(fn: (payload: Record<string, unknown>) => void): () => void {
  turnOptionDecorators.push(fn);
  return () => {
    const i = turnOptionDecorators.indexOf(fn);
    if (i !== -1) turnOptionDecorators.splice(i, 1);
  };
}

// Send any payload over the socket (rooms use this; chat turns use sendChat).
export async function sendWs(payload: Record<string, unknown>): Promise<void> {
  const sock = await ensureSocket();
  sock.send(JSON.stringify(payload));
}

// Per-turn cursor into the active assistant message's parts. textPart/thinking
// hold the reactive proxies of the currently-open runs (or null).
const turn = {
  textPart: null as TextPart | null,
  thinking: null as ThinkingPart | null,
  thinkingStartedAt: 0,
  thinkingRaw: '', // accumulated reasoning source → part.text at end (remount-safe)
};

// Texts of steer-while-busy notes awaiting their note_queued / note_rejected
// ack. FIFO — acks arrive in send order on the same socket.
const pendingNotes: string[] = [];

let socket: WebSocket | null = null;
let openWaiters: Array<(s: WebSocket) => void> = [];

// Auto-reconnect: the server pushes events unprompted (background deliveries,
// channel turns, session updates), so a dropped socket can't wait for the next
// outbound send to heal. Backoff 1s → 15s, reset on a successful open.
let reconnectDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    if (!socket) connectWs();
  }, reconnectDelay);
}

export function connectWs(): void {
  if (socket) return;
  // The text island drains its tail after message_end, then calls this.
  setOnDone(finalizeTurn);

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const s = new WebSocket(`${proto}//${location.host}/ws`);
  socket = s;

  s.addEventListener('open', () => {
    ui.wsConnected = true;
    reconnectDelay = 1000;
    const waiters = openWaiters;
    openWaiters = [];
    for (const r of waiters) r(s);
  });
  s.addEventListener('close', () => {
    ui.wsConnected = false;
    socket = null;
    if (chat.isStreaming) { resetTurn(); resetThinking(); finalizeTurn(); }
    scheduleReconnect();
  });
  s.addEventListener('error', () => { ui.wsConnected = false; });
  s.addEventListener('message', (e) => {
    let data: WsEvent;
    try { data = JSON.parse(e.data as string) as WsEvent; } catch { return; }
    dispatch(data);
  });
}

function ensureSocket(): Promise<WebSocket> {
  if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  connectWs();
  return new Promise((resolve) => { openWaiters.push(resolve); });
}

// Send a chat turn. Lazily creates the session on first message (default chat
// mode). While a turn is RUNNING, plain text becomes a steer-while-busy note:
// the server folds it into the running turn's mailbox and acks note_queued
// (the bubble renders on the ack). Attachments need a full turn of their own.
export async function sendChat(content: string): Promise<void> {
  const text = content.trim();
  const hasPending = composer.pending.length > 0;
  // Captured once — every use below an await checks against this so an agent
  // switch mid-flight abandons the send instead of writing cross-agent state.
  const agentId = ui.currentAgentId;
  if ((!text && !hasPending) || !agentId) return;

  if (chat.isStreaming) {
    if (!text || hasPending || !chat.sessionId) return;
    pendingNotes.push(text);
    try {
      const sock = await ensureSocket();
      sock.send(JSON.stringify({
        type: 'message',
        sessionId: chat.sessionId,
        agentId,
        content: text,
      }));
    } catch {
      pendingNotes.pop();
      appendError('WebSocket connection failed');
    }
    return;
  }

  if (!chat.sessionId) {
    try {
      const { id } = await createSession(agentId);
      if (ui.currentAgentId !== agentId) return; // switched away — orphan the empty session
      chat.sessionId = id;
      void loadSessions(); // surface the new session in the sidebar
    } catch (e) {
      appendError(e instanceof Error ? e.message : String(e));
      return;
    }
  }

  let sock: WebSocket;
  try {
    sock = await ensureSocket();
  } catch {
    appendError('WebSocket connection failed');
    return;
  }
  if (ui.currentAgentId !== agentId) return;

  const sessionId = chat.sessionId;
  if (!sessionId) return;

  // Upload staged attachments (the session exists now), then attach to the bubble.
  let fileIds: string[] = [];
  let attachments: Attachment[] = [];
  if (hasPending) {
    try {
      const r = await uploadPending(agentId, sessionId);
      fileIds = r.fileIds;
      attachments = r.attachments;
    } catch (e) {
      appendError(e instanceof Error ? e.message : 'Upload failed');
    }
    clearPending();
    if (ui.currentAgentId !== agentId || chat.sessionId !== sessionId) return;
  }

  chat.messages.push(mkMessage('user', text, { attachments }));
  beginAssistantTurn();

  const payload: Record<string, unknown> = {
    type: 'message',
    sessionId,
    agentId,
    content: text,
  };
  if (fileIds.length) payload.attachments = fileIds;
  if (composer.editPending) {
    // This send replaces the (already stripped) last user turn — the server
    // drops it + everything after before appending this message.
    payload.edit = true;
    composer.editPending = false;
  }
  applyTurnOptions(payload);
  sock.send(JSON.stringify(payload));
}

// Fresh streaming turn: clear both islands + part cursors, open the bubble.
function beginAssistantTurn(): void {
  chat.isStreaming = true;
  resetTurn();
  resetThinking();
  turn.textPart = null;
  turn.thinking = null;
  turn.thinkingStartedAt = 0;
  chat.messages.push(mkMessage('assistant', '', { streaming: true }));
}

// Inference selections ride the payload (omitted ones → server uses agent
// defaults).
// Room decorators run last (voice adds voiceMode/voiceProvider when on).
function applyTurnOptions(payload: Record<string, unknown>): void {
  if (prefs.backendId) payload.provider = prefs.backendId;
  if (prefs.model) payload.model = prefs.model;
  if (prefs.thinkingLevel !== 'off') payload.thinkingLevel = prefs.thinkingLevel;
  // Fast mode ships only when the selection actually supports it — the stored
  // preference must not leak onto the wire for inapplicable backends/models.
  if (prefs.fastMode && fastModeAvailable()) payload.fastMode = true;
  // Force the pack off when the user disabled it OR when Englyph isn't ready, so a
  // greyed-out "off" memory chip never still ships a pack request (omitting the
  // flag = the server treats it as ON) and fires dead Englyph calls. `=== false`
  // only: an unknown/undefined readiness leaves the pref alone, matching the
  // chip's `memDisabled = !!feature && !feature.ready` gate.
  if (!prefs.memoryPack || getFeature('memory')?.ready === false) payload.memoryPack = false;
  for (const fn of turnOptionDecorators) fn(payload);
}

// Abort the running turn (the loop answers with error:"Aborted" → rendered as
// a calm "Turn stopped" note, and the turn finalizes through the normal path).
export function stopTurn(): void {
  if (!chat.isStreaming || !chat.sessionId || !ui.currentAgentId) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'stop', sessionId: chat.sessionId, agentId: ui.currentAgentId }));
}

// Re-run the last assistant turn. The server truncates its transcript back to
// the prior user turn; we strip the stale bubble (+ anything after it) so the
// view matches, then stream the fresh attempt into a new bubble.
export async function retryTurn(): Promise<void> {
  const agentId = ui.currentAgentId;
  const sessionId = chat.sessionId;
  if (chat.isStreaming || !sessionId || !agentId) return;
  let lastIdx = -1;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    if (chat.messages[i].role === 'assistant') { lastIdx = i; break; }
  }
  if (lastIdx === -1) return;

  let sock: WebSocket;
  try {
    sock = await ensureSocket();
  } catch {
    appendError('WebSocket connection failed');
    return;
  }
  if (ui.currentAgentId !== agentId || chat.sessionId !== sessionId) return;

  chat.messages.splice(lastIdx); // stale reply + trailing error/system notes
  beginAssistantTurn();

  const payload: Record<string, unknown> = {
    type: 'retry',
    sessionId,
    agentId,
    content: '',
  };
  applyTurnOptions(payload);
  sock.send(JSON.stringify(payload));
}

// Edit the last user turn: strip it (+ everything after) from the view, load
// its text into the composer, and mark the next send as the replacement. The
// server's dropLastUserAndAfter mirrors the strip when that send lands.
// Notes never anchor an edit (same rule as the backend's retry/edit anchoring).
export function editLastTurn(): void {
  if (chat.isStreaming) return;
  let idx = -1;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (m.role === 'user' && !m.origin) { idx = i; break; }
  }
  if (idx === -1) return;
  composer.draft = chat.messages[idx].text;
  composer.editPending = true;
  chat.messages.splice(idx);
}

function dispatch(ev: WsEvent): void {
  const type = ev.type ?? '';

  // A registered room claims its events before the chat path sees them.
  if (routeToRoom(ev)) return;

  // Events for rooms not yet ported (no registration) — keep them off the
  // chat path. Each entry disappears as its room lands in src/rooms/.
  // 'cron' rides the same synthetic-delivery pipeline as 'background': the
  // activity room claims both; this net just covers pre-registration races.
  if (
    ev.source === 'background' ||
    ev.source === 'cron' ||
    type.startsWith('call_') ||
    type.startsWith('channel') ||
    type.startsWith('tts_')
  ) {
    return;
  }

  switch (type) {
    case 'text_delta':
      ensureTextRun();
      pushDelta(ev.text ?? '');
      // Mirror the source text onto the part — the island renders to DOM
      // only, so this is what voice replay (and future copy) read back.
      if (turn.textPart) turn.textPart.raw = (turn.textPart.raw ?? '') + (ev.text ?? '');
      break;

    case 'thinking_delta':
      ensureThinking();
      pushThinking(ev.text ?? '');
      // Mirror the source — the reasoning island writes only to the DOM, so a
      // remount (stage swap) needs this to render the block statically.
      if (turn.thinking) turn.thinkingRaw += ev.text ?? '';
      break;

    case 'thinking_end':
      endThinking();
      break;

    case 'tool_call_start': {
      // A tool interrupts text — finalize the current run so it lands above the
      // tools container, then add the pending tool.
      endTextRun();
      endThinking();
      const last = activeAssistant();
      if (last && ev.id && ev.name) {
        last.tools.push({
          id: ev.id,
          name: ev.name,
          input: null,
          result: null,
          isError: false,
          status: 'pending',
          label: '',
          tag: '',
          output: '',
          startedAt: 0,
          collapsed: true,
        });
      }
      break;
    }

    case 'tool_call_input': {
      const tool = findTool(ev.id);
      if (tool) tool.input = ev.input ?? null;
      break;
    }

    case 'tool_call_executing': {
      const tool = findTool(ev.id);
      if (tool) {
        tool.startedAt = ev.startedAt ?? Date.now();
        if (ev.label) tool.label = ev.label;
      }
      break;
    }

    case 'tool_call_progress': {
      const tool = findTool(ev.id);
      if (tool) {
        // UI-only cap (the full output still went to the model). Keep the tail.
        tool.output = (tool.output + (ev.chunk ?? '')).slice(-50000);
        tool.collapsed = false; // auto-expand so live output is visible
      }
      break;
    }

    case 'tool_call_result': {
      const tool = findTool(ev.id);
      if (tool) {
        tool.isError = ev.isError === true;
        tool.status = tool.isError ? 'error' : 'success';
        tool.result = ev.result ?? '';
        if (ev.tag) tool.tag = ev.tag;
      }
      break;
    }

    case 'agent_attachment': {
      const att = ev.attachment;
      const last = activeAssistant();
      if (att?.fileId && last && ui.currentAgentId && chat.sessionId) {
        last.attachments.push({
          kind: kindFromCategory(att.category ?? '', att.mediaType ?? ''),
          name: att.filename ?? 'attachment',
          size: att.size ?? 0,
          url: uploadUrl(ui.currentAgentId, chat.sessionId, att.fileId),
          mediaType: att.mediaType,
        });
      }
      break;
    }

    case 'message_end': {
      // This turn's prompt size is the current context usage — prefer the
      // provider-correct contextTokens (Claude's cache-inclusive total), with
      // inputTokens as the fallback for shapes that don't carry it.
      if (ev.usage) {
        const ctx = typeof ev.usage.contextTokens === 'number' ? ev.usage.contextTokens
          : typeof ev.usage.inputTokens === 'number' ? ev.usage.inputTokens : null;
        if (ctx != null) usage.contextTokens = ctx;
      }
      // Authoritative window + compaction threshold for the model that ran.
      if (typeof ev.contextWindow === 'number') usage.contextWindow = ev.contextWindow;
      if (typeof ev.compactionThreshold === 'number') usage.compactionThreshold = ev.compactionThreshold;
      // Turn telemetry onto the finalized bubble (header meta line).
      const live = activeAssistant();
      if (live) {
        if (ev.usage) {
          live.usage = {
            in: ev.usage.inputTokens ?? 0,
            out: ev.usage.outputTokens ?? 0,
            tokPerSec: ev.usage.tokensPerSec,
          };
        }
        if (live.ts) live.durationMs = Date.now() - live.ts;
      }
      endTurn();
      break;
    }

    // ── Steer-while-busy notes ──────────────────────────────────────────────
    case 'note_queued': {
      // The mailbox accepted it — render the note bubble (above the streaming
      // assistant bubble so the reply stays last).
      const text = pendingNotes.shift();
      if (text) {
        const note = mkMessage('user', text, {});
        note.origin = 'note';
        note.noteState = 'queued';
        insertBeforeStreamingBubble(note);
      }
      break;
    }

    case 'note_rejected': {
      // Usually a race: the turn ended between our isStreaming check and the
      // server's. If we're idle now, send it as the regular message it should
      // have been; otherwise surface the reason.
      const text = pendingNotes.shift();
      if (text && !chat.isStreaming) void sendChat(text);
      else appendError(ev.reason ?? 'Note rejected');
      break;
    }

    case 'note_delivered': {
      // The loop folded the queued note(s) into the running turn.
      for (const m of chat.messages) {
        if (m.origin === 'note' && m.noteState === 'queued') m.noteState = 'delivered';
      }
      break;
    }

    case 'blank_response': {
      const last = activeAssistant();
      if (last) last.blank = true;
      resetTurn();
      resetThinking();
      finalizeTurn();
      break;
    }

    case 'error': {
      // A busy rejection while a note is awaiting its ack is REQUEST-scoped —
      // the server refused that send (pre-mailbox backend or a lock race); the
      // actual turn is still streaming. Consume it without killing the turn.
      if (chat.isStreaming && pendingNotes.length > 0 && (ev.error ?? '').includes('busy')) {
        pendingNotes.shift();
        const note = mkMessage('system', `Note not delivered - ${ev.error}`, { error: true });
        insertBeforeStreamingBubble(note);
        break;
      }
      resetTurn();
      resetThinking();
      finalizeTurn();
      // A user /stop surfaces as error:"Aborted" — that's an outcome, not a
      // failure; render it calm instead of red.
      if (ev.error === 'Aborted') chat.messages.push(mkMessage('system', 'Turn stopped.'));
      else appendError(ev.error ?? 'Unknown error');
      break;
    }

    default:
      break;
  }
}

// ── Run management ───────────────────────────────────────────────────────────

// Open a text run if none is active (lazy — covers text-first and post-tool/
// post-thinking continuations). Holds the reactive proxy so `active` (cursor)
// stays reactive.
function ensureTextRun(): void {
  if (turn.textPart) return;
  const last = activeAssistant();
  if (!last) return;
  last.parts.push({ kind: 'text', id: crypto.randomUUID(), active: true });
  turn.textPart = last.parts[last.parts.length - 1] as TextPart;
}

// Finalize the current text run (tool / thinking interrupt, or turn end).
function endTextRun(): void {
  if (!turn.textPart) return;
  interrupt();
  turn.textPart.active = false;
  // Durable text so a remount (the systems/channel stage swap unmounts Chat)
  // re-renders the bubble — the island wrote only to the DOM; raw is the source.
  if (turn.textPart.raw != null) turn.textPart.text = turn.textPart.raw;
  turn.textPart = null;
}

function ensureThinking(): void {
  if (turn.thinking) return;
  const last = activeAssistant();
  if (!last) return;
  // Interleaved thinking interrupts text so part ordering stays correct.
  endTextRun();
  last.parts.push({ kind: 'thinking', id: crypto.randomUUID(), status: 'streaming', durationSec: 0, collapsed: false });
  turn.thinking = last.parts[last.parts.length - 1] as ThinkingPart;
  turn.thinkingStartedAt = Date.now();
  turn.thinkingRaw = '';
}

function endThinking(): void {
  finishThinking();
  if (!turn.thinking) return;
  turn.thinking.status = 'done';
  turn.thinking.durationSec = Math.max(1, Math.round((Date.now() - turn.thinkingStartedAt) / 1000));
  turn.thinking.collapsed = true;
  if (turn.thinkingRaw) turn.thinking.text = turn.thinkingRaw; // durable across a remount
  turn.thinking = null;
}

// Flip the turn done: cursor off, composer re-enabled. Called by the text
// island's drain (onDone) on graceful end, or directly on error/blank/disconnect.
function finalizeTurn(): void {
  endThinking();
  if (turn.textPart) {
    turn.textPart.active = false;
    if (turn.textPart.raw != null) turn.textPart.text = turn.textPart.raw; // durable across a remount
    turn.textPart = null;
  }
  chat.isStreaming = false;
  const last = activeAssistant();
  if (last) last.streaming = false;
  void loadSessions(); // refresh title / lastMessageAt / count after the turn
}

function findTool(id: string | undefined): ToolCall | undefined {
  if (!id) return undefined;
  return activeAssistant()?.tools.find((t) => t.id === id);
}

function activeAssistant(): ChatMessage | null {
  const last = chat.messages[chat.messages.length - 1];
  return last && last.role === 'assistant' ? last : null;
}

function appendError(message: string): void {
  chat.messages.push(mkMessage('system', message, { error: true }));
}

// Insert above the live assistant bubble so the streaming reply stays last
// (used for note bubbles and request-scoped notices that land mid-turn).
function insertBeforeStreamingBubble(m: ChatMessage): void {
  const last = chat.messages[chat.messages.length - 1];
  const at = last?.role === 'assistant' && last.streaming ? chat.messages.length - 1 : chat.messages.length;
  chat.messages.splice(at, 0, m);
}

// Exported for lib/commands.ts — slash-command results render as the same
// system notes the turn pipeline emits.
export function mkMessage(
  role: ChatMessage['role'],
  text: string,
  flags: Partial<Pick<ChatMessage, 'streaming' | 'error' | 'blank' | 'attachments'>> = {},
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    text,
    parts: [],
    tools: [],
    toolsOpen: false,
    attachments: flags.attachments ?? [],
    streaming: flags.streaming ?? false,
    error: flags.error ?? false,
    blank: flags.blank ?? false,
    ts: Date.now(),
  };
}
