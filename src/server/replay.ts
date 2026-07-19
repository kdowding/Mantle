// Voice replay subsystem — re-synthesize a past bubble's text through the
// agent's voice WITHOUT running the agent loop. Peeled out of ws.ts (the
// transport hub keeps a thin dispatch); lives next to voice-pipeline.ts,
// which owns the synth machinery it drives.
//
// Lifecycle: the UI's per-message speaker icon sends `replay` with a
// client-generated replayId; audio streams back over the same tts_* events
// as a live reply; `replay_stop` aborts by id; a socket close aborts every
// replay that connection owns (nobody is listening — don't burn GPU into a
// dead socket).

import type { ServerWebSocket } from "bun";
import type { MantleConfig } from "../config/schema.js";
import { getAgent } from "../config/loader.js";
import type { VoiceManager } from "../voice/manager.js";
import { buildVoicePipeline, type VoiceProvider } from "./voice-pipeline.js";
import type { ClientMessage, WsData } from "./ws-types.js";

// Active voice replays, keyed by client-supplied replayId. Doesn't share
// state with the chat-turn controllers because replays don't take the
// session lock — they run alongside (or independent of) an active turn.
const activeReplays = new Map<string, { controller: AbortController; ws: ServerWebSocket<WsData> }>();

export function stopReplay(replayId: string): void {
  activeReplays.get(replayId)?.controller.abort();
}

// Abort + clear every replay owned by a closing connection.
export function abortReplaysForWs(ws: ServerWebSocket<WsData>): void {
  for (const [id, entry] of activeReplays) {
    if (entry.ws === ws) {
      try { entry.controller.abort(); } catch { /* already aborted */ }
      activeReplays.delete(id);
    }
  }
}

// Shutdown counterpart — replays don't take the session lock, so the
// chat-turn sweep never sees them and the synth pipeline would keep
// streaming into a tearing-down sidecar.
export function abortAllReplays(): number {
  let count = 0;
  for (const entry of activeReplays.values()) {
    try { entry.controller.abort(); count++; } catch { /* already aborted */ }
  }
  return count;
}

export async function handleReplay(
  ws: ServerWebSocket<WsData>,
  msg: ClientMessage,
  config: MantleConfig,
  voiceManager?: VoiceManager,
): Promise<void> {
  const replayId = msg.replayId!;
  // Duplicate replayId (double-click, client retry) would overwrite the
  // map entry: the first replay becomes unstoppable and its finally then
  // deletes the SECOND's entry. Refuse instead. handleReplay is
  // fire-and-forget, but this check (and the set below) run before its
  // first await — handlers run concurrently, so that synchronous window
  // is what makes the guard race-free.
  if (activeReplays.has(replayId)) {
    ws.send(JSON.stringify({ type: "tts_error", replayId, error: "Replay already in progress" }));
    return;
  }
  const agent = getAgent(config, msg.agentId);
  if (!agent) {
    ws.send(JSON.stringify({ type: "tts_error", replayId, error: `Unknown agent: ${msg.agentId}` }));
    return;
  }

  // Provider defaults to chatterbox for back-compat (old clients didn't
  // send this field). Validate per-provider: chatterbox needs the
  // sidecar alive; xAI needs the Grok API key. The "no voice file"
  // case is checked inside buildVoicePipeline for chatterbox.
  const provider: VoiceProvider = msg.voiceProvider ?? "chatterbox";
  if (provider === "chatterbox" && !voiceManager?.isAlive()) {
    ws.send(JSON.stringify({ type: "tts_error", replayId, error: "Voice sidecar is not running" }));
    return;
  }
  if (provider === "xai" && !config.providers.grok.apiKey) {
    ws.send(JSON.stringify({ type: "tts_error", replayId, error: "xAI TTS requires an XAI_API_KEY" }));
    return;
  }

  const controller = new AbortController();
  activeReplays.set(replayId, { controller, ws });

  const pipeline = buildVoicePipeline(provider, ws, config, voiceManager, agent.id, controller.signal, /*replay*/ true, msg.text);
  if (!pipeline) {
    activeReplays.delete(replayId);
    const detail = provider === "chatterbox" ? `No voice file for agent ${agent.id}` : `xAI TTS unavailable for agent ${agent.id}`;
    ws.send(JSON.stringify({ type: "tts_error", replayId, error: detail }));
    return;
  }

  // Tell the client this turn is voice-bound and tag it as a replay so
  // the UI knows not to wire text-reveal callbacks (the bubble's text
  // is already on screen — we're only adding audio, not gating display).
  try {
    ws.send(JSON.stringify({
      type: "tts_start",
      synthId: pipeline.synthId,
      replayId,
    }));
  } catch { /* ws closed */ }

  pipeline.feed(msg.text!);
  try {
    await pipeline.flushAndWait();
  } catch (err) {
    console.warn(`[MANTLE:voice] replay ${replayId} failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    activeReplays.delete(replayId);
  }
}
