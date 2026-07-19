// Shared reactive app state — the runes replacement for the vanilla UI's
// free-floating globals. One module; components read reactively, writes go
// through here or through the WS turn pipeline (lib/ws.ts).
import type { Agent, Profile, SessionMeta, Backend, KeyVendor, ProviderKeyState, Connections, FeatureReadiness } from './api';
import type { Island } from './stream';

export const ui = $state({
  agents: [] as Agent[],
  currentAgentId: null as string | null,
  profile: null as Profile | null,
  wsConnected: false,
  // Systems deck — the full-page management surface for the agent's
  // subsystems. Non-null swaps the stage to the deck at that tab (the
  // sidebar ⤢ buttons set it); App keeps it mutually exclusive with the
  // channel view. Follows the current agent; selecting a session exits.
  deckTab: null as null | 'skills' | 'tools' | 'cron' | 'personality',
  // True once the initial /api/config load lands — lets the shell tell "still
  // loading" apart from "loaded, no agents" (the fresh-clone onboarding state).
  configLoaded: false,
});

export const sessions = $state({
  list: [] as SessionMeta[],
});

// Backend catalog + limits from /api/config (the inference chrome's data).
export const serverConfig = $state({
  backends: [] as Backend[],
  vendorLabels: {} as Record<string, string>,
  defaultProvider: null as string | null,
  modelContextWindows: {} as Record<string, number>,
  defaultContextWindow: 200000,
  // Where compaction fires, as a fraction of the active model's window (0.6 =
  // at 60% full) — the context bar's marker, applied to whichever window shows.
  compactionFraction: 0.6,
  // Server-side capability gates (realtime / xaiTts / localModels / music).
  features: {} as Record<string, boolean>,
  // Per-provider key presence + source — drives the Providers settings tab.
  providerKeys: {} as Partial<Record<KeyVendor, ProviderKeyState>>,
  // The user's profile name (how agents address them) — from /api/config.
  user: { name: '' },
});

// Live subsystem readiness from /api/connections — the single source the feature
// gates read (memory toggle, music transcribe) AND the Connections settings tab
// renders, so enforcement can't drift from the health shown. Loaded on boot +
// refreshed after settings changes; null until the first load, and gates treat
// "unknown" as not-disabled so there's no false-disable flicker before it lands.
export const connections = $state({
  data: null as Connections | null,
});

// One feature's readiness row by id (memory / voice / stt / ttsChatterbox /
// ttsXai / realtime / localModels / music) — undefined until readiness loads.
export function getFeature(id: string): FeatureReadiness | undefined {
  return connections.data?.features?.find((f) => f.id === id);
}

// ── Avatar cache-busting ──────────────────────────────────────────────────
// Per-agent version tokens. The avatar URL is otherwise stable so the browser
// can 304-revalidate it cheaply on every agent switch (see the ETag note in
// server/api-agent-surface.ts). The catch: a stable URL means a freshly
// uploaded avatar never re-fetches — already-mounted <img>s keep showing the
// cached old bytes. Bumping an agent's token on upload is the ONE thing that
// changes its URL, forcing every surface to pull the new image, while leaving
// the common no-upload path untouched.
export const avatarVersions = $state<Record<string, number>>({});

export function bumpAvatar(agentId: string): void {
  avatarVersions[agentId] = (avatarVersions[agentId] ?? 0) + 1;
}

// Build a cache-bust-aware avatar URL. Reactive when read in a template /
// $derived — re-derives when the agent's token bumps. Pass `base` to version a
// server-supplied URL (the profile blob's avatarUrl); omit it to address the
// canonical endpoint. Token 0 ⇒ bare URL, so first paint matches the stable
// form the ETag cache keys on.
export function avatarSrc(agentId: string, base?: string): string {
  const v = avatarVersions[agentId] ?? 0;
  const url = base ?? `/api/agents/${encodeURIComponent(agentId)}/avatar`;
  return v > 0 ? `${url}${url.includes('?') ? '&' : '?'}v=${v}` : url;
}

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// Per-turn inference selections (persisted to localStorage via lib/inference.ts).
// backendId/model are sent as `provider`/`model`; thinkingLevel/memoryPack/
// fastMode ride the payload; showReasoning is display-only (hides thinking
// blocks). fastMode only ships when the selection supports it (codex priority
// tier) — the stored preference survives model swaps either way.
export const prefs = $state({
  backendId: null as string | null,
  model: null as string | null,
  thinkingLevel: 'off' as ThinkingLevel,
  fastMode: false,
  showReasoning: true,
  memoryPack: true,
});

// Live context usage — set from message_end. `contextTokens` is the prompt
// size of the last turn (provider-correct: Claude's is cache-inclusive).
// `contextWindow`/`compactionThreshold` are the authoritative gauge bounds for
// the model that actually ran (null until the first turn lands — the gauge
// falls back to the static /api/config values meanwhile).
export const usage = $state({
  contextTokens: 0,
  contextWindow: null as number | null,
  compactionThreshold: null as number | null,
});

// A streamed text run. For live turns its content is owned imperatively by the
// streaming island (lib/stream.ts), which Svelte must not manage; `active`
// drives the cursor. For transcript replay, `text` holds the full content (the
// component renders it once via smd, no island).
export interface TextPart {
  kind: 'text';
  id: string;
  active: boolean;
  text?: string;
  // A part-owned island overrides the chat singleton (the voice room's
  // audio-paced reveal runs its own; StreamingText attaches whichever).
  island?: Island;
  // Accumulated source text of a LIVE run (the island owns the DOM, so
  // without this a finalized live bubble has no readable text). Voice
  // replay reads it; a future copy-button would too. Replay-from-transcript
  // parts carry `text` instead.
  raw?: string;
  // Entrance sizing ghost — the full text rendered hidden UNDER the typing
  // island (same grid cell), so the bubble owns its final height from frame
  // one and typing never pushes the layout around.
  ghost?: string;
}

// A reasoning block. Live content is island-owned (lib/reasoning.ts, a separate
// slower char-fade typewriter); on replay `text` holds it (rendered instantly).
// `status`/`durationSec`/`collapsed` are reactive.
export interface ThinkingPart {
  kind: 'thinking';
  id: string;
  status: 'streaming' | 'done';
  durationSec: number;
  collapsed: boolean;
  text?: string;
}

export type MsgPart = TextPart | ThinkingPart;

// A tool call. All reactive — the blocks re-render from this as events land.
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;          // null until tool_call_input
  result: string | null;   // null until tool_call_result
  isError: boolean;
  status: 'pending' | 'success' | 'error';
  label: string;           // tool_call_executing (model-derived)
  tag: string;             // tool_call_result classifier chip
  output: string;          // tool_call_progress (live, accumulated)
  startedAt: number;       // for the live Ns counter (0 until executing)
  collapsed: boolean;      // per-tool body open/closed
}

// A rendered attachment on a message (user upload or agent-attached file).
export interface Attachment {
  kind: 'image' | 'audio' | 'video' | 'file';
  name: string;
  size: number;
  url: string; // server url (or a blob: url before upload completes)
  mediaType?: string;
  extractedText?: string;
}

// One chat message. User/system text is reactive; assistant content lives in
// `parts` (ordered thinking/text runs, content island-owned) + `tools` (the
// bottom collapsible container). `attachments` render in user bubbles (uploads)
// and assistant bubbles (agent-attached files). `streaming` gates the turn.
// origin:'note' = a steer-while-busy mid-turn note (compact bubble, NOTE chip;
// noteState tracks queued → delivered against the loop's mailbox).
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  parts: MsgPart[];
  tools: ToolCall[];
  toolsOpen: boolean;
  attachments: Attachment[];
  streaming: boolean;
  error: boolean;
  blank: boolean;
  // 'note' = steer-while-busy mid-turn note; 'delivery' = a harness
  // background/cron delivery block (renders as a framed system seam).
  origin?: 'note' | 'delivery';
  noteState?: 'queued' | 'delivered';
  // "— new since you left —" seam inserted at transcript load.
  divider?: boolean;
  // Session-entrance choreography slot (0-based among the animated tail):
  // the bubble lands minimized, window-restores open at its stagger slot,
  // and assistant text types out through a per-message island.
  entranceOrder?: number;
  // One-time guard: set the first time the bubble mounts, so returning to chat
  // from the systems/channel stage swap (which unmounts + remounts Chat)
  // renders it statically instead of replaying the pop or blanking the text.
  entranceConsumed?: boolean;
  // Voice room contract: audio for this turn is still playing out. Shows the
  // Responding… indicator and defers retry until playback completes (the turn
  // isn't really over when message_end lands — the voice is mid-sentence).
  voiceLive?: boolean;
  // Turn telemetry — header meta line. `ts` (epoch ms) stamps live messages
  // at creation and replayed ones from the JSONL timestamp; usage/duration
  // land at message_end (live turns only — transcripts don't store usage).
  ts?: number;
  usage?: { in: number; out: number; tokPerSec?: number };
  durationMs?: number;
}

// A file staged in the composer before send (holds the File + a blob preview).
export interface PendingAttachment {
  id: number;
  kind: Attachment['kind'];
  name: string;
  size: number;
  file: File;
  previewUrl: string; // blob: url for images, '' otherwise
}

// `draft` is the composer text (module state so edit-last-turn can load it);
// `editPending` marks the next send as a replacement for the stripped last
// user turn (rides the WS payload as `edit: true`).
export const composer = $state({
  pending: [] as PendingAttachment[],
  dragging: false,
  draft: '',
  editPending: false,
});

// Fullscreen viewer targets (null = closed): image lightbox, PDF doc viewer,
// format-aware text viewer. Set via lib/viewers.ts openFilePreview.
export const overlay = $state({
  lightboxUrl: null as string | null,
  doc: null as { url: string; name: string } | null,
  text: null as { name: string; content: string } | null,
});

export const chat = $state({
  sessionId: null as string | null,
  messages: [] as ChatMessage[],
  isStreaming: false,
});

// Reset the conversation (new session / agent switch). Session creation is
// lazy — the next sent message mints the session id.
export function resetChat(): void {
  chat.sessionId = null;
  chat.messages = [];
  chat.isStreaming = false;
  composer.editPending = false; // an edit never crosses sessions
  usage.contextTokens = 0; // the gauge never carries across sessions
  usage.contextWindow = null;
  usage.compactionThreshold = null;
}
