// WS wire types + the broadcast registry, extracted from ws.ts so the
// modules that only need a TYPE (voice-pipeline, call-bridge) or only need
// BROADCAST (delivery plumbing via injection) don't import the transport
// hub itself. Before this split an 8-file import cycle through ws.ts was
// held together purely by `import type` + one lazy `await import` — one
// careless value import would have re-created a real init cycle.

import type { ServerWebSocket } from "bun";
import type { ProviderName } from "../config/schema.js";
import type { ClientChunkReport } from "../voice/turn-log.js";

// Voice synthesis providers. "chatterbox" runs through the local python
// sidecar (voice cloning, GPU, sub-chunk streaming). "xai" hits xAI's
// hosted TTS API (no sidecar, fixed voice catalog). Defined here (not in
// voice-pipeline.ts, which re-exports it) so this module stays a LEAF —
// importing the pipeline for one union would re-create the type cycle
// this file exists to break.
export type VoiceProvider = "chatterbox" | "xai";

// Per-socket data payload for Bun's upgrade call. Nothing reads ws.data
// today — the type exists so every handler signature shares one generic
// parameter and a future per-connection field has a home.
export interface WsData {
  authedUser?: string;
}

export interface ClientMessage {
  type: "message" | "stop" | "retry" | "note" | "replay" | "replay_stop" | "tts_playback_report"
      | "call_start" | "call_audio" | "call_text" | "call_interrupt" | "call_end"
      // [channel] bolt-on: inbound channel turn messages.
      | "channel_message" | "channel_stop" | "channel_retry"
      // Deck assist: an embedded helper turn against an open artifact.
      | "assist_message";
  sessionId: string;
  agentId: string;
  content: string;
  // [channel] bolt-on: target channel for channel_message / channel_stop.
  channelId?: string;
  // [channel] client-generated id for the user message row, so the optimistic
  // echo bubble carries a stable id reactions can target before any reload.
  channelClientId?: string;
  // [channel] private aside: agent ids the user is whispering to — the message
  // (and its replies) stay visible to the user + these agents only. Validated
  // in ws.ts's wire pass; the bridge intersects with the live roster.
  whisperTo?: string[];
  // ── Realtime call fields ─────────────────────────────────────────────
  // callId: server-generated UUID returned in call_started. The browser
  // echoes it on every subsequent call_audio / call_text / call_end so
  // the bridge knows which active call the message targets.
  // voice: xAI voice id (eve/ara/rex/sal/leo or a custom voice) chosen at
  //   call_start. Only meaningful on the call_start message.
  // audio: base64 PCM16 LE @ 24kHz frame. Only meaningful on call_audio.
  callId?: string;
  voice?: string;
  audio?: string;
  // Replay-only: client-generated id correlating a `replay` request with
  // its `replay_stop`. Server uses it as the key into activeReplays.
  replayId?: string;
  // assist_message only: client-generated id correlating the request with
  // its assist_delta / assist_done events. The structured request (target
  // artifact + conversation) rides `content` as JSON; assist.ts validates.
  assistId?: string;
  // tts_playback_report only: which turn (server-issued synthId) the
  // playback timeline belongs to, plus the per-chunk events (relative ms
  // from the client's tts_start receive).
  synthId?: string;
  playbackChunks?: ClientChunkReport[];
  // Replay-only: the text to re-synthesize. Skips the agent loop entirely
  // — just feeds this verbatim into a voice pipeline using the agent's
  // saved tuning. Sent through the chunker like a streaming reply so the
  // user hears the same per-sentence pacing as the original.
  text?: string;
  attachments?: string[];
  provider?: ProviderName;
  model?: string;
  persona?: string;
  // Per-turn reasoning preference for message/retry turns.
  thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
  // Per-turn Codex subscription fast tier for message/retry turns. The server
  // accepts only literal true; other values behave as omitted.
  fastMode?: boolean;
  // When true on a "message" type, the server first drops the most
  // recent user turn (and any assistant turns/tool results that came
  // after it) before appending this message. The UI uses this to
  // implement edit-the-last-prompt semantics.
  edit?: boolean;
  // When true, the assistant reply is also synthesized to speech via
  // the voice sidecar and audio chunks are streamed back as tts_audio
  // events. Also injects the voice-mode system prompt so the model
  // writes spoken-friendly output. Ignored on CC sessions (no in-loop
  // text-delta interception there). Caller is responsible for ensuring
  // the TTS model is loaded — synth calls fail loudly otherwise.
  voiceMode?: boolean;
  // Which TTS engine to use when voiceMode is on. Defaults to
  // "chatterbox" if absent (back-compat with clients that predate the
  // xAI toggle). Same field is also accepted on `replay` messages so
  // the per-message speaker icon honors the user's active toggle.
  voiceProvider?: VoiceProvider;
  // When false, skip the pre-inference memory pack — the turn runs
  // without englyph_search fan-out and without the recalled-memories
  // dynamic-zone block. Englyph, MEMORY.md, ingestion, and mining are
  // unaffected; only the per-turn recall is bypassed. Default = true
  // (pack on) when the field is omitted.
  memoryPack?: boolean;
}

// ── Broadcast registry ───────────────────────────────────────────────────
// Every currently-open WebSocket. ws.ts registers/unregisters sockets from
// its open/close handlers; everything else only ever broadcasts. Consumers
// OUTSIDE src/server (core delivery plumbing, rooms) don't import this —
// they receive `broadcastToAllWebSockets` injected as a capability, which
// is what keeps the import graph one-directional.

const activeWebSockets = new Set<ServerWebSocket<WsData>>();

export function registerWebSocket(ws: ServerWebSocket<WsData>): void {
  activeWebSockets.add(ws);
}

export function unregisterWebSocket(ws: ServerWebSocket<WsData>): void {
  activeWebSockets.delete(ws);
}

export function broadcastToAllWebSockets(message: Record<string, unknown>): number {
  if (activeWebSockets.size === 0) return 0;
  const payload = JSON.stringify(message);
  let sent = 0;
  for (const ws of activeWebSockets) {
    try {
      ws.send(payload);
      sent++;
    } catch {
      // WebSocket may have closed mid-broadcast; drop silently
    }
  }
  return sent;
}
