// Realtime voice-call bridge. Sits between the browser WebSocket and
// xAI's Grok Voice Agent (via RealtimeManager): opens a call on
// call_start, relays audio/text/interrupt/end, and tears calls down when
// the browser WS drops. Peeled out of ws.ts; the transport handler
// delegates every call_* message to routeCallMessage and the WS close
// hook to closeCallsForWs.

import type { ServerWebSocket } from "bun";
import { resolve } from "path";
import type { MantleConfig } from "../config/schema.js";
import type { RealtimeManager } from "../realtime/manager.js";
import { buildCallInstructions } from "../realtime/instructions.js";
import { getAgent } from "../config/loader.js";
import { SessionManager, mutateSessionIndex } from "../agent/session.js";
import type { PersonaProfile } from "../agent/prompt-builder.js";
import { loadPersonas } from "./personas.js";
import type { ClientMessage, WsData } from "./ws-types.js";
import { sendAudioFrame } from "./ws-send.js";

// Tracks which realtime calls belong to which WebSocket connection so we
// can close them all on browser disconnect. Calls don't take the session
// lock — they're orthogonal to chat — but they DO need to be torn down
// when their owning WS drops, otherwise we leak open xAI WebSockets (and
// their $0.05/min meter) after a browser refresh.
const wsCalls = new Map<ServerWebSocket<WsData>, Set<string>>();

// Connections with a call_start currently mid-handshake. WS handlers run
// CONCURRENTLY (Bun does NOT serialize them per-connection), so two rapid
// call_start frames would each open a metered xAI socket — the guard must be
// taken synchronously, before handleCallStart's first await.
const callStarting = new Set<ServerWebSocket<WsData>>();

// Route a call_* message. Returns true if msg.type was a realtime-call
// type (and was handled here), false otherwise so the caller keeps
// dispatching. Audio frames are the hot path (~25/sec) — direct lookup,
// no extra validation.
export function routeCallMessage(
  ws: ServerWebSocket<WsData>,
  msg: ClientMessage,
  config: MantleConfig,
  realtimeManager?: RealtimeManager,
): boolean {
  // call_start spins up an xAI Realtime WebSocket on the server. The
  // browser doesn't know the callId until call_started lands, so it
  // can't race ahead with call_audio — the audio handler just no-ops for
  // unknown callIds anyway. Fire-and-forget so this handler returns
  // immediately and the first call_audio frames aren't blocked behind the
  // WS open + session.update. The callStarting guard is taken HERE,
  // synchronously, because handlers run concurrently (see above).
  if (msg.type === "call_start" && msg.agentId && msg.sessionId) {
    if (callStarting.has(ws)) {
      try {
        ws.send(JSON.stringify({ type: "call_error", error: "A call is already starting on this connection" }));
      } catch { /* ws closed */ }
      return true;
    }
    callStarting.add(ws);
    handleCallStart(ws, msg, config, realtimeManager)
      .catch((err) => {
        console.warn(`[MANTLE:realtime] call_start threw: ${err instanceof Error ? err.message : err}`);
      })
      .finally(() => callStarting.delete(ws));
    return true;
  }
  if (msg.type === "call_audio" && msg.callId && msg.audio) {
    const session = realtimeManager?.get(msg.callId);
    if (session) session.pushAudio(msg.audio);
    return true;
  }
  if (msg.type === "call_text" && msg.callId && msg.text) {
    const session = realtimeManager?.get(msg.callId);
    if (session) session.sendText(msg.text);
    return true;
  }
  if (msg.type === "call_interrupt" && msg.callId) {
    const session = realtimeManager?.get(msg.callId);
    if (session) session.interrupt();
    return true;
  }
  if (msg.type === "call_end" && msg.callId) {
    // Manager.end triggers RealtimeSession.close → onClosed hook which
    // removes the call from wsCalls and notifies the browser.
    realtimeManager?.end(msg.callId, "client");
    return true;
  }
  return false;
}

// End any in-flight realtime calls this WS owns. Otherwise the xAI
// WebSocket stays open (along with its meter) until the server side
// detects the connection death — which can take a while and costs real
// money. Called from the WS close hook.
export function closeCallsForWs(ws: ServerWebSocket<WsData>, realtimeManager?: RealtimeManager): void {
  const calls = wsCalls.get(ws);
  if (calls && realtimeManager) {
    for (const callId of calls) {
      try { realtimeManager.end(callId, "client"); } catch { /* best effort */ }
    }
  }
  wsCalls.delete(ws);
}

// Opens a realtime call session. Validates the call-mode session exists,
// resolves agent + persona, builds flattened instructions, opens the xAI
// WebSocket through RealtimeManager, and wires its hooks back to this
// browser WS. Fires call_started on success, call_error + call_closed
// on failure. Fire-and-forget from the message handler (which holds the
// per-connection callStarting guard for the duration) so later frames —
// including the first call_audio — aren't blocked behind the handshake.
async function handleCallStart(
  ws: ServerWebSocket<WsData>,
  msg: ClientMessage,
  config: MantleConfig,
  realtimeManager?: RealtimeManager,
): Promise<void> {
  function sendErr(error: string, code?: string): void {
    try {
      ws.send(JSON.stringify({ type: "call_error", error, code }));
      ws.send(JSON.stringify({ type: "call_closed", reason: "error", detail: error }));
    } catch { /* ws closed */ }
  }

  if (!realtimeManager) return sendErr("Realtime manager unavailable on this server");
  if (!config.realtime.enabled) return sendErr("Realtime calls are disabled in config");

  const apiKey = config.providers.grok.apiKey;
  if (!apiKey) {
    return sendErr("No xAI API key configured — set providers.grok.apiKey or XAI_API_KEY");
  }

  const agent = getAgent(config, msg.agentId);
  if (!agent) return sendErr(`Unknown agent: ${msg.agentId}`);

  const baseMantleDir = resolve(config.basePath, ".mantle");
  const sessionsDir = resolve(baseMantleDir, "sessions", msg.agentId);
  const session = new SessionManager(msg.sessionId, sessionsDir);
  const meta = session.getMeta();
  if (!meta?.isCall) {
    return sendErr(`Session ${msg.sessionId} is not in call mode — create one via POST /api/agents/:id/sessions with mode: "call"`);
  }

  // Voice resolution: per-message override > session meta > config default.
  const voice = (msg.voice?.trim()) || meta.callVoice || config.realtime.defaultVoice;

  // Persona resolution mirrors handleChat: explicit msg.persona > the
  // agent's personas.json currentState. Locked at call start; mid-call
  // persona swapping isn't supported (session.update could hot-swap
  // instructions but voice mid-call would feel jarring — defer).
  const personasConfig = loadPersonas(agent.workspace);
  const requestedPersona = msg.persona ?? personasConfig?.currentState;
  let personaOpts: { name: string; profile: PersonaProfile } | undefined;
  if (personasConfig && requestedPersona && personasConfig.profiles[requestedPersona]) {
    personaOpts = {
      name: requestedPersona,
      profile: personasConfig.profiles[requestedPersona],
    };
    // Persist the chosen persona on the session meta so the sidebar
    // shows it (and a future "re-listen to this call" affordance can
    // tell which mask was active).
    if (meta.persona !== requestedPersona) {
      try {
        mutateSessionIndex(sessionsDir, (index) => {
          const m = index.sessions.find((s) => s.id === msg.sessionId);
          if (!m) return false;
          m.persona = requestedPersona;
          m.lastMessagePersona = requestedPersona;
        });
      } catch { /* best effort */ }
    }
  }

  // Persist the chosen voice on meta too if it differs from what was
  // recorded at session creation (user picked a different voice in the
  // call overlay before clicking start).
  if (meta.callVoice !== voice) {
    try {
      mutateSessionIndex(sessionsDir, (index) => {
        const m = index.sessions.find((s) => s.id === msg.sessionId);
        if (!m) return false;
        m.callVoice = voice;
      });
    } catch { /* best effort */ }
  }

  const instructions = buildCallInstructions({
    workspacePath: agent.workspace,
    persona: personaOpts,
  });

  const callId = crypto.randomUUID();
  const maxDurationMs = config.realtime.maxMinutesPerCall * 60 * 1000;
  const startedAt = Date.now();

  console.log(
    `[MANTLE:realtime] call_start agent=${msg.agentId} session=${msg.sessionId} ` +
    `voice=${voice} model=${config.realtime.defaultModel} callId=${callId.slice(0, 8)} ` +
    `apiKeyLen=${apiKey.length}`,
  );

  try {
    await realtimeManager.start(callId, {
      apiKey,
      model: config.realtime.defaultModel,
      agentId: msg.agentId,
      sessionId: msg.sessionId,
      voice,
      instructions,
      session,
      maxDurationMs,
      onAudioOut: (audioBase64) => {
        // Backpressure-gated (~25fps hot path): a stalled client drops
        // frames and stays live instead of buffering the call in memory.
        sendAudioFrame(ws, JSON.stringify({ type: "call_audio", callId, audio: audioBase64, sampleRate: 24000 }), "call_audio");
      },
      onUserTranscript: (text) => {
        try { ws.send(JSON.stringify({ type: "call_user_transcript", callId, text })); } catch { /* ws closed */ }
      },
      onAssistantTranscriptDelta: (text) => {
        try { ws.send(JSON.stringify({ type: "call_assistant_transcript_delta", callId, text })); } catch { /* ws closed */ }
      },
      onAssistantTranscriptDone: (text) => {
        try { ws.send(JSON.stringify({ type: "call_assistant_transcript_done", callId, text })); } catch { /* ws closed */ }
      },
      onUserSpeechStart: () => {
        try { ws.send(JSON.stringify({ type: "call_speaking_state", callId, who: "user", state: "start" })); } catch { /* ws closed */ }
      },
      onUserSpeechEnd: () => {
        try { ws.send(JSON.stringify({ type: "call_speaking_state", callId, who: "user", state: "end" })); } catch { /* ws closed */ }
      },
      onAssistantSpeechStart: () => {
        try { ws.send(JSON.stringify({ type: "call_speaking_state", callId, who: "assistant", state: "start" })); } catch { /* ws closed */ }
      },
      onAssistantSpeechEnd: () => {
        try { ws.send(JSON.stringify({ type: "call_speaking_state", callId, who: "assistant", state: "end" })); } catch { /* ws closed */ }
      },
      onError: (message, code) => {
        try { ws.send(JSON.stringify({ type: "call_error", callId, error: message, code })); } catch { /* ws closed */ }
      },
      onClosed: (reason, detail) => {
        const set = wsCalls.get(ws);
        if (set) {
          set.delete(callId);
          if (set.size === 0) wsCalls.delete(ws);
        }
        try { ws.send(JSON.stringify({ type: "call_closed", callId, reason, detail })); } catch { /* ws closed */ }
      },
    });

    // Register against this WS for cleanup-on-disconnect. Done after
    // manager.start succeeds so a failed open doesn't leave a phantom
    // entry behind.
    let set = wsCalls.get(ws);
    if (!set) { set = new Set(); wsCalls.set(ws, set); }
    set.add(callId);

    // The browser may have disconnected DURING the xAI handshake — its close
    // hook ran before this call was registered, so nothing ended it. Without
    // this re-check the call meters against a dead socket for up to
    // maxMinutesPerCall. Registered-then-checked so a close racing this very
    // line is still covered by closeCallsForWs.
    if (ws.readyState !== 1 /* OPEN */) {
      console.warn(`[MANTLE:realtime] browser WS closed during call_start — ending call ${callId.slice(0, 8)}`);
      realtimeManager.end(callId, "client");
      return;
    }

    console.log(`[MANTLE:realtime] call ${callId.slice(0, 8)} → WS open, notifying browser`);
    try {
      ws.send(JSON.stringify({
        type: "call_started",
        callId,
        sessionId: msg.sessionId,
        voice,
        startedAt,
        maxDurationMs,
      }));
    } catch { /* ws closed */ }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[MANTLE:realtime] call_start failed for ${msg.agentId}: ${errorMsg}`);
    sendErr(errorMsg);
  }
}
