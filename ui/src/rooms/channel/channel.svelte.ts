// Channel room — multi-agent group chat (the Svelte port of ui/channel.js).
// State + REST + the WS wiring: registers on ws.ts's onWsEvent seam (the
// room claims channel_* events before chat dispatch) and runs ONE stream
// island per live bubble via lib/stream's createIsland factory — a volley can
// have one speaker's tail still draining while the next opens.
//
// P1 scope (like the old room): conversational view — thinking/tool events
// inside channel_event are intentionally not surfaced. Reactions and
// per-agent model overrides are deferred.
import { ui } from '../../lib/state.svelte';
import { onWsEvent, sendWs, type WsEvent } from '../../lib/ws';
import { createIsland, type Island } from '../../lib/stream';
import { lsGet, lsSet } from '../../lib/storage';
import { confirmDialog } from '../../components/confirm.svelte';

const LS_LAST = 'mantle-channel-last';
const LS_MODE = 'mantle-channel-mode'; // '1' = reload lands back in channel mode
export const VOLLEY_CAP_UI = 12; // mirrors the server's VOLLEY_CAP clamp

export interface ChannelVolley {
  enabled: boolean;
  maxTurns: number;
  style: string;
}

export interface ChannelModelOverride {
  provider?: string;
  model?: string;
}

export interface ChannelMeta {
  id: string;
  title: string;
  participants: string[];
  autoRespond: string[];
  volley: ChannelVolley;
  memoryPack?: boolean;
  modelOverrides?: Record<string, ChannelModelOverride>;
  lastActiveAgentId?: string;
  lastMessageAt?: string;
}

// One tool call surfaced on a live agent bubble (recall / web lookup) — a
// compact activity chip, not the 1:1 chat's full collapsible block.
export interface ChannelToolChip {
  id: string;
  name: string;
  label?: string; // human summary from tool_call_executing
  status: 'run' | 'ok' | 'err';
}

// An emoji reaction on a row. `by` is 'user' or an agentId (mirrors the
// server's ChannelReaction).
export interface ChannelReaction {
  emoji: string;
  by: string;
}

export interface ChannelMsg {
  key: string; // ui key
  kind: 'user' | 'agent' | 'system';
  agentId?: string;
  name?: string;
  accent?: string;
  text: string; // static content (replay / user echo); live bubbles are island-owned
  timestamp?: string;
  live: boolean; // island owns the content node
  typing: boolean; // speaker started, no token yet
  error?: string;
  blank: boolean;
  tools: ChannelToolChip[];
  // Private aside scope — agent ids this row is visible to (besides the
  // user). Drives the dashed "whisper" bubble treatment + the aside tag.
  whisper?: string[];
  // The PERSISTED row id (replay: row.id; user echo: the trusted clientId;
  // live agent bubble: stamped from channel_speaker_end). Reactions key off
  // it — unset means the row can't take reactions yet.
  msgId?: string;
  reactions?: ChannelReaction[];
  // Live bubble finished streaming (speaker_end) — the reveal clock may
  // still be draining, but msg.text is complete (copy becomes safe).
  done?: boolean;
}

export const channel = $state({
  open: false, // channel MODE — swaps the stage to the channel view + shows the channel sidebar
  mgmtOpen: false, // ≤768px: the channel sidebar as an off-canvas drawer (desktop CSS ignores it)
  channels: [] as ChannelMeta[],
  activeId: null as string | null,
  meta: null as ChannelMeta | null,
  msgs: [] as ChannelMsg[],
  loading: false,
  sending: false, // a turn is in flight — composer disabled until turn_complete
  volleyMeter: null as { remaining: number; nextUp?: string } | null,
  // Composer whisper mode: agent ids the next sends go to privately. STICKY
  // (a real aside spans several messages) — cleared explicitly, on channel
  // switch, and self-heals against the roster on send.
  whisperTo: [] as string[],
});

// Live bubbles keyed by `${agentId} ${turnSeq}` — reactive msg proxy + island.
const live = new Map<string, { msg: ChannelMsg; island: Island }>();

function uuid(): string {
  return crypto.randomUUID();
}

export function agentById(id: string | undefined) {
  return ui.agents.find((a) => a.id === id);
}
export function agentName(id: string | undefined): string {
  return agentById(id)?.name ?? id ?? '?';
}

// The live bubble's island for a message (LiveText attaches to it on mount).
export function islandFor(msg: ChannelMsg): Island | null {
  for (const v of live.values()) if (v.msg === msg || v.msg.key === msg.key) return v.island;
  return null;
}

// ── REST ─────────────────────────────────────────────────────────────────────

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

export async function fetchChannels(): Promise<void> {
  try {
    channel.channels = await api<ChannelMeta[]>('GET', '/api/channels');
  } catch {
    channel.channels = [];
  }
}

export async function createChannel(title: string, participants: string[]): Promise<ChannelMeta> {
  const meta = await api<ChannelMeta>('POST', '/api/channels', { title, participants });
  await fetchChannels();
  return meta;
}

export async function deleteChannel(meta: ChannelMeta): Promise<void> {
  const ok = await confirmDialog({
    title: 'Delete channel',
    message: `Delete #${meta.title}?\nIts transcript is removed permanently.`,
    confirmText: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/channels/${encodeURIComponent(meta.id)}`);
  } finally {
    if (channel.activeId === meta.id) {
      channel.activeId = null;
      channel.meta = null;
      channel.msgs = [];
      channel.sending = false;
      clearLive();
    }
    await fetchChannels();
  }
}

export async function patchParticipants(patch: { add?: string[]; remove?: string[] }): Promise<void> {
  if (!channel.activeId) return;
  channel.meta = await api<ChannelMeta>('PATCH', `/api/channels/${encodeURIComponent(channel.activeId)}/participants`, patch);
}

export async function patchAutoRespond(agentId: string, on: boolean): Promise<void> {
  if (!channel.activeId) return;
  channel.meta = await api<ChannelMeta>('PATCH', `/api/channels/${encodeURIComponent(channel.activeId)}/auto-respond`, { agentId, on });
}

export async function patchVolley(patch: Partial<ChannelVolley>): Promise<void> {
  if (!channel.activeId) return;
  channel.meta = await api<ChannelMeta>('PATCH', `/api/channels/${encodeURIComponent(channel.activeId)}/volley`, patch);
}

// Channel meta knobs: rename + the per-channel memory-pack toggle.
export async function patchChannelMeta(patch: { title?: string; memoryPack?: boolean }): Promise<void> {
  if (!channel.activeId) return;
  channel.meta = await api<ChannelMeta>('PATCH', `/api/channels/${encodeURIComponent(channel.activeId)}`, patch);
  if (patch.title) await fetchChannels(); // sidebar shows the new name
}

// Sticky per-agent provider/model override (both empty = back to agent default).
export async function patchModelOverride(agentId: string, provider?: string, model?: string): Promise<void> {
  if (!channel.activeId) return;
  channel.meta = await api<ChannelMeta>(
    'PATCH',
    `/api/channels/${encodeURIComponent(channel.activeId)}/model-override`,
    { agentId, provider, model },
  );
}

// ── Open / select / replay ───────────────────────────────────────────────────

// Mode survives a reload (LS_LAST already restores the channel itself).
export function channelModeSaved(): boolean {
  return lsGet(LS_MODE) === '1';
}

export async function openChannelView(id?: string): Promise<void> {
  channel.open = true;
  lsSet(LS_MODE, '1');
  if (id) {
    // Caller knows the channel (sidebar click / just-created) — load it now;
    // the list refresh doesn't gate the swap, it just keeps ordering fresh.
    void fetchChannels();
    await selectChannel(id);
    return;
  }
  await fetchChannels();
  const want = lsGet(LS_LAST);
  const target = want && channel.channels.some((c) => c.id === want)
    ? want
    : channel.channels[0]?.id ?? null;
  if (target) await selectChannel(target);
}

export function closeChannelView(): void {
  channel.open = false;
  channel.mgmtOpen = false;
  lsSet(LS_MODE, '0');
}

interface ReplayRow {
  id?: string;
  role?: string;
  timestamp?: string;
  content?: unknown;
  author?: { kind?: string; agentId?: string; name?: string; accentColor?: string };
  whisper?: { to?: string[] };
  reactions?: ChannelReaction[];
}

function extractText(row: ReplayRow): string {
  const c = row.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return (c as Array<{ type?: string; text?: string }>)
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }
  return '';
}

export async function selectChannel(id: string): Promise<void> {
  channel.activeId = id;
  channel.mgmtOpen = false; // mobile: picking a channel closes the drawer
  lsSet(LS_LAST, id);
  clearLive();
  // A hard context switch: a previous channel's in-flight turn keeps running
  // server-side but its events are dropped by the channelId guard — including
  // its turn_complete, the only thing that clears `sending`. Reset here.
  channel.sending = false;
  channel.volleyMeter = null;
  channel.whisperTo = []; // an aside never follows you to another channel
  channel.loading = true;
  channel.msgs = [];
  try {
    const [meta, rows] = await Promise.all([
      api<ChannelMeta>('GET', `/api/channels/${encodeURIComponent(id)}`),
      api<ReplayRow[]>('GET', `/api/channels/${encodeURIComponent(id)}/messages`),
    ]);
    if (channel.activeId !== id) return; // superseded
    channel.meta = meta;
    channel.msgs = rows.flatMap((row): ChannelMsg[] => {
      const text = extractText(row);
      // Working rows share the channel JSONL (assistant tool_use turns AND
      // tool_result rows, which are role:"user") — skip anything textless.
      if (!text) return [];
      if (row.author?.kind === 'agent') {
        return [{
          key: row.id ?? uuid(),
          kind: 'agent',
          agentId: row.author.agentId,
          name: row.author.name ?? agentName(row.author.agentId),
          accent: row.author.accentColor,
          text,
          timestamp: row.timestamp,
          live: false,
          typing: false,
          blank: false,
          tools: [],
          whisper: row.whisper?.to,
          msgId: row.id,
          reactions: row.reactions ?? [],
        }];
      }
      if (row.role === 'user') {
        return [{
          key: row.id ?? uuid(), kind: 'user', text, timestamp: row.timestamp,
          live: false, typing: false, blank: false, tools: [],
          whisper: row.whisper?.to, msgId: row.id, reactions: row.reactions ?? [],
        }];
      }
      return [];
    });
  } catch (e) {
    if (channel.activeId === id) {
      channel.msgs = [{ key: uuid(), kind: 'system', text: `Failed to load channel: ${e instanceof Error ? e.message : e}`, live: false, typing: false, blank: false, tools: [] }];
    }
  } finally {
    if (channel.activeId === id) channel.loading = false;
  }
}

// ── Sending / stopping / retry ───────────────────────────────────────────────

export async function sendChannelMessage(content: string): Promise<void> {
  const text = content.trim();
  if (!text || !channel.activeId || channel.sending) return;
  // Whisper mode: self-heal the target list against the live roster (an
  // agent may have been dismissed since the aside started). The SERVER
  // re-validates; this just keeps the echo bubble honest.
  const roster = channel.meta?.participants ?? [];
  const whisperTo = channel.whisperTo.filter((id) => roster.includes(id));
  channel.whisperTo = whisperTo;
  const clientId = uuid();
  channel.msgs.push({
    key: clientId, kind: 'user', text, live: false, typing: false, blank: false, tools: [],
    whisper: whisperTo.length > 0 ? [...whisperTo] : undefined,
    // The server trusts a well-formed client uuid as the row id, so the echo
    // bubble can take reactions before any reload.
    msgId: clientId,
    reactions: [],
  });
  // One send can yield N speaker cycles — the composer stays disabled for the
  // WHOLE turn, re-enabled only on channel_turn_complete.
  channel.sending = true;
  try {
    await sendWs({
      type: 'channel_message',
      channelId: channel.activeId,
      content: text,
      channelClientId: clientId,
      ...(whisperTo.length > 0 ? { whisperTo } : {}),
    });
  } catch {
    channel.sending = false;
    channel.msgs.push({ key: uuid(), kind: 'system', text: 'Not connected.', live: false, typing: false, blank: false, tools: [] });
  }
}

// Toggle the USER's emoji reaction on a row (agents react via their
// channel_react tool). Server-authoritative: apply whatever comes back.
export async function toggleUserReaction(msg: ChannelMsg, emoji: string): Promise<void> {
  if (!channel.activeId || !msg.msgId) return;
  const has = (msg.reactions ?? []).some((r) => r.by === 'user' && r.emoji === emoji);
  try {
    const res = await api<{ messageId: string; reactions: ChannelReaction[] }>(
      'PATCH',
      `/api/channels/${encodeURIComponent(channel.activeId)}/messages/${encodeURIComponent(msg.msgId)}/reactions`,
      { emoji, on: !has },
    );
    msg.reactions = res.reactions;
  } catch {
    /* row not persisted yet / channel gone — leave the bar as-is */
  }
}

// Toggle one agent in/out of the composer's whisper set.
export function toggleWhisperTarget(agentId: string): void {
  const i = channel.whisperTo.indexOf(agentId);
  if (i === -1) channel.whisperTo.push(agentId);
  else channel.whisperTo.splice(i, 1);
}

export function clearWhisper(): void {
  channel.whisperTo = [];
}

// "Jump in" — abort the in-flight volley so the floor returns to the user.
export function jumpIn(): void {
  if (!channel.activeId) return;
  void sendWs({ type: 'channel_stop', channelId: channel.activeId });
}

// Re-run the last user message: strip everything after it, resend server-side.
export async function retryChannelTurn(): Promise<void> {
  if (!channel.activeId || channel.sending) return;
  let lastUser = -1;
  for (let i = channel.msgs.length - 1; i >= 0; i--) {
    if (channel.msgs[i].kind === 'user') { lastUser = i; break; }
  }
  if (lastUser === -1) return;
  channel.msgs.splice(lastUser + 1);
  clearLive();
  channel.sending = true;
  try {
    await sendWs({ type: 'channel_retry', channelId: channel.activeId });
  } catch {
    channel.sending = false;
  }
}

// ── Inbound WS events (registered on the ws.ts room seam) ────────────────────

const bubbleKey = (agentId: string, turnSeq: number): string => `${agentId} ${turnSeq}`;

function clearLive(): void {
  for (const v of live.values()) v.island.reset();
  live.clear();
}

export function registerChannelWs(): () => void {
  return onWsEvent('channel', handle);
}

interface ChannelEvent extends WsEvent {
  channelId?: string;
  agentId?: string;
  turnSeq?: number;
  accentColor?: string;
  messageId?: string;
  whisperTo?: string[];
  reactions?: ChannelReaction[];
  lastActiveAgentId?: string;
  remaining?: number;
  maxTurns?: number;
  turnsUsed?: number;
  nextUp?: string;
  event?: {
    type?: string;
    text?: string;
    error?: string;
    // tool_call_* family (surfaced as activity chips on the live bubble)
    id?: string;
    name?: string;
    label?: string;
    isError?: boolean;
  };
}

function handle(raw: WsEvent): void {
  const ev = raw as ChannelEvent;
  // No channel open, or an event scoped to a channel we're not viewing (the WS
  // is shared) — the other turn keeps running server-side; nothing to render.
  if (!channel.activeId) return;
  if (ev.channelId && ev.channelId !== channel.activeId) return;

  switch (ev.type) {
    case 'channel_speaker_start': return onSpeakerStart(ev);
    case 'channel_event': return onAgentEvent(ev);
    case 'channel_speaker_end': return onSpeakerEnd(ev);
    case 'channel_system':
      channel.msgs.push({ key: uuid(), kind: 'system', text: ev.text ?? '', live: false, typing: false, blank: false, tools: [] });
      return;
    case 'channel_volley_state': {
      const remaining = ev.remaining ?? Math.max(0, (ev.maxTurns ?? 0) - (ev.turnsUsed ?? 0));
      channel.volleyMeter = { remaining, nextUp: ev.nextUp };
      return;
    }
    case 'channel_reaction': {
      // An agent reacted (channel_react tool) — update the targeted row.
      if (!ev.messageId) return;
      const m = channel.msgs.find((x) => x.msgId === ev.messageId || x.key === ev.messageId);
      if (m) m.reactions = ev.reactions ?? [];
      return;
    }
    case 'channel_turn_complete':
      channel.sending = false;
      channel.volleyMeter = null;
      if (channel.meta && ev.lastActiveAgentId) channel.meta.lastActiveAgentId = ev.lastActiveAgentId;
      void fetchChannels(); // refresh roster order/timestamps in the background
      return;
    default:
      return; // channel_reaction et al — deferred
  }
}

function onSpeakerStart(ev: ChannelEvent): void {
  if (!ev.agentId || ev.turnSeq == null) return;
  const key = bubbleKey(ev.agentId, ev.turnSeq);
  if (live.has(key)) return;
  const msg: ChannelMsg = {
    key: uuid(),
    kind: 'agent',
    agentId: ev.agentId,
    name: ev.name ?? agentName(ev.agentId),
    accent: ev.accentColor,
    text: '',
    live: true,
    typing: true,
    blank: false,
    tools: [],
    whisper: ev.whisperTo,
  };
  channel.msgs.push(msg);
  // Hold the reactive proxy (the pushed copy), not the local literal.
  const proxy = channel.msgs[channel.msgs.length - 1];
  const island = createIsland();
  island.setOnDone(() => live.delete(key));
  live.set(key, { msg: proxy, island });
}

function onAgentEvent(ev: ChannelEvent): void {
  if (!ev.agentId || ev.turnSeq == null) return;
  const key = bubbleKey(ev.agentId, ev.turnSeq);
  if (!live.has(key)) {
    // channel_event for a turn whose speaker_start we missed (race) — create
    // the bubble lazily so no text is dropped.
    onSpeakerStart(ev);
  }
  const entry = live.get(key);
  if (!entry) return;
  const inner = ev.event ?? {};
  switch (inner.type) {
    case 'text_delta':
      // First token: LiveText swaps the typing dots for the island node and
      // attaches on mount; buffered deltas reveal then (order-independent).
      if (entry.msg.typing) entry.msg.typing = false;
      entry.island.push(inner.text ?? '');
      // Mirror the source text onto the msg so finalized bubbles stay
      // copyable/inspectable (the island owns the rendered DOM).
      entry.msg.text += inner.text ?? '';
      break;
    // Tool activity chips — recall / web lookups show as compact chips on the
    // live bubble (the pseudo-tools stay invisible: yield is a non-event and
    // react lands as a reaction).
    case 'tool_call_start': {
      const name = inner.name ?? '';
      if (name && !name.startsWith('channel_')) {
        entry.msg.tools.push({ id: inner.id ?? `t${entry.msg.tools.length}`, name, status: 'run' });
      }
      break;
    }
    case 'tool_call_executing': {
      const t = entry.msg.tools.find((x) => x.id === inner.id);
      if (t && inner.label) t.label = inner.label;
      break;
    }
    case 'tool_call_result': {
      const t = entry.msg.tools.find((x) => x.id === inner.id);
      if (t) t.status = inner.isError ? 'err' : 'ok';
      break;
    }
    case 'error':
      // Flush whatever revealed, then surface the error line in the bubble.
      entry.island.interrupt();
      entry.msg.error = inner.error ?? 'error';
      entry.msg.typing = false;
      live.delete(key);
      break;
    default:
      // thinking_* — intentionally not surfaced (a hangout reply is the show).
      break;
  }
}

function onSpeakerEnd(ev: ChannelEvent): void {
  if (!ev.agentId || ev.turnSeq == null) return;
  const key = bubbleKey(ev.agentId, ev.turnSeq);
  const entry = live.get(key);
  if (!entry) return;
  // The persisted assistant row id — the reaction bar's target.
  if (ev.messageId) entry.msg.msgId = ev.messageId;
  entry.msg.done = true;
  if (entry.msg.typing) {
    // No text ever arrived — leave a thin blank marker.
    entry.msg.typing = false;
    entry.msg.blank = true;
    entry.island.reset();
    live.delete(key);
    return;
  }
  // Let the reveal clock drain the tail, then the island's onDone unregisters.
  entry.island.end();
}

// ── @-mention scan (composer autocomplete) ───────────────────────────────────

export interface MentionMatch {
  id: string;
  name: string;
  accent?: string;
}

export type MentionScan =
  | { kind: 'none' }
  | { kind: 'suggest'; matches: MentionMatch[]; atIdx: number };

export function participants(): MentionMatch[] {
  const ids = channel.meta?.participants ?? [];
  return ids.map((id) => {
    const a = agentById(id);
    return { id, name: a?.name ?? id, accent: (a as { accentColor?: string } | undefined)?.accentColor };
  });
}

// Find an "@fragment" under the caret; suggest participants matching it.
export function scanMention(text: string, pos: number): MentionScan {
  const before = text.slice(0, pos);
  const atIdx = before.lastIndexOf('@');
  if (atIdx === -1) return { kind: 'none' };
  if (atIdx > 0 && !/\s/.test(before[atIdx - 1])) return { kind: 'none' }; // mid-word @
  const fragment = before.slice(atIdx + 1);
  if (/\s/.test(fragment)) return { kind: 'none' };
  const q = fragment.toLowerCase();
  const matches = participants().filter(
    (p) => p.id.toLowerCase().startsWith(q) || p.name.toLowerCase().startsWith(q),
  );
  if (!matches.length) return { kind: 'none' };
  return { kind: 'suggest', matches, atIdx };
}
