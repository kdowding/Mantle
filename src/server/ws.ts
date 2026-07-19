import type { ServerWebSocket } from "bun";
import type { MantleConfig } from "../config/schema.js";
import type { MessageContent } from "../agent/providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { getAgent } from "../config/loader.js";
import { SessionManager, mutateSessionIndex } from "../agent/session.js";
import type { PersonaProfile } from "../agent/prompt-builder.js";
import { coerceThinkingLevel, type AgentStreamEvent } from "../agent/loop.js";
import { runTriggeredAgentTurn } from "../agent/triggered-turn.js";
import { resolveProviderTurn } from "../agent/providers/catalog.js";
import type { LocalModelManager } from "../local/manager.js";
import { compactIfNeeded, effectiveCompactionThreshold, resolveContextWindow } from "../agent/compaction.js";
import { withAgentLock } from "../agent/agent-lock.js";
import { postTurnNote } from "../agent/turn-mailbox.js";
import { resolveAttachmentsForProvider, getFileMetadata } from "../agent/attachments.js";
import { buildMemoryPack, findPriorTurnTexts } from "../agent/memory-pack.js";
import { resolve } from "path";
import type { VoiceManager } from "../voice/manager.js";
import { buildVoicePipeline, applyPlaybackReport, type VoiceProvider } from "./voice-pipeline.js";
import { handleReplay, stopReplay, abortReplaysForWs } from "./replay.js";
import type { RealtimeManager } from "../realtime/manager.js";
import { routeCallMessage, closeCallsForWs } from "./call-bridge.js";
// [channel] bolt-on: route channel_* messages to the channel bridge.
import { routeChannelMessage } from "../rooms/channel/bridge.js";
import { routeAssistMessage } from "./assist.js";
import { chatToolHidden } from "./chat-tool-surface.js";
import type { IntegrationRegistry } from "../integrations/types.js";
import { loadPersonas } from "./personas.js";
// Wire types + the open-socket broadcast registry live in ws-types.ts (the
// leaf module) — this file is the transport hub that registers sockets.
import {
  registerWebSocket,
  unregisterWebSocket,
  type ClientMessage,
  type WsData,
} from "./ws-types.js";

export type { ClientMessage, WsData } from "./ws-types.js";

// Track active sessions to prevent concurrent agent loops
const activeSessions = new Set<string>();

// Is a chat turn currently running in this session? Exported so REST routes
// that rewrite the session JSONL (POST …/compact) can 409 instead of racing
// the loop's appends with a whole-file replace.
export function isSessionActive(agentId: string, sessionId: string): boolean {
  return activeSessions.has(`${agentId}:${sessionId}`);
}
// Abort controllers for active agent loops (for /stop support)
const activeControllers = new Map<string, AbortController>();

// Aborts every in-flight chat turn — called from the index.ts shutdown hook so
// SIGINT/SIGTERM lets loops persist partial state before dependencies stop.
export function abortAllActiveTurns(): number {
  let count = 0;
  for (const controller of activeControllers.values()) {
    try { controller.abort(); count++; } catch { /* already aborted */ }
  }
  return count;
}

// Replay subsystem lives in replay.ts — re-exported so index.ts's shutdown
// keeps one import site for turn sweeps.
export { abortAllReplays } from "./replay.js";

// The open-socket set + broadcastToAllWebSockets live in ws-types.ts.
// Consumers outside src/server receive broadcast as an injected
// capability (index.ts wires it) rather than importing the hub.

export function createWebSocketHandler(
  config: MantleConfig,
  registry: ToolRegistry,
  backgroundRunner?: import("../agent/background-runner.js").BackgroundTaskRunner,
  voiceManager?: VoiceManager,
  realtimeManager?: RealtimeManager,
  subagentManager?: import("../agent/subagent-manager.js").SubagentManager,
  localModelManager?: LocalModelManager,
  integrations?: IntegrationRegistry,
) {
  return {
    open(ws: ServerWebSocket<WsData>) {
      console.log("[MANTLE:ws] Client connected");
      registerWebSocket(ws);
    },

    async message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
        return;
      }

      // ── Wire-shape validation, ONCE, before any dispatch ──────────────
      // JSON.parse hands us whatever the client sent — the ClientMessage
      // type is a claim, not a guarantee. Everything downstream (mailbox,
      // SessionManager — which mkdirs + appends at the RESOLVED path —
      // channel bridge, call bridge) may assume: ids are path-safe strings,
      // content/text are strings with sane caps. Reject here so a crafted
      // sessionId can't write JSONL outside .mantle/sessions and a non-
      // string content can't throw past the handler's try (unhandled
      // rejection).
      {
        const SAFE_ID = /^[\w-]{1,128}$/;
        const bad = (field: string): void => {
          ws.send(JSON.stringify({ type: "error", error: `Invalid ${field}` }));
        };
        if (msg.sessionId !== undefined && (typeof msg.sessionId !== "string" || !SAFE_ID.test(msg.sessionId))) {
          bad("sessionId");
          return;
        }
        if (msg.agentId !== undefined && (typeof msg.agentId !== "string" || !SAFE_ID.test(msg.agentId))) {
          bad("agentId");
          return;
        }
        if (msg.channelId !== undefined && (typeof msg.channelId !== "string" || !SAFE_ID.test(msg.channelId))) {
          bad("channelId");
          return;
        }
        if (msg.assistId !== undefined && (typeof msg.assistId !== "string" || !SAFE_ID.test(msg.assistId))) {
          bad("assistId");
          return;
        }
        // [channel] whisper recipients: a short list of path-safe agent ids.
        if (
          msg.whisperTo !== undefined &&
          (!Array.isArray(msg.whisperTo) ||
            msg.whisperTo.length > 16 ||
            msg.whisperTo.some((id) => typeof id !== "string" || !SAFE_ID.test(id)))
        ) {
          bad("whisperTo");
          return;
        }
        // 512KB chat-content cap: far above any legitimate paste (uploads
        // exist for real payloads), far below the buffer-bloat zone.
        if (msg.content !== undefined && (typeof msg.content !== "string" || msg.content.length > 512 * 1024)) {
          bad("content");
          return;
        }
        // Replay text re-synthesizes ONE bubble — 64KB is generous.
        if (msg.text !== undefined && (typeof msg.text !== "string" || msg.text.length > 64 * 1024)) {
          bad("text");
          return;
        }
      }

      // Handle stop messages
      if (msg.type === "stop" && msg.sessionId && msg.agentId) {
        const key = `${msg.agentId}:${msg.sessionId}`;
        const controller = activeControllers.get(key);
        if (controller) controller.abort();
        return;
      }

      // Steer-while-busy note: deliver text into a RUNNING turn's mailbox
      // without interrupting it — the loop folds it in at its next iteration
      // and the model decides whether to adjust course or finish first.
      // note_queued acks acceptance; the loop's own note_delivered event
      // confirms when it actually reached the model.
      if (msg.type === "note" && msg.sessionId) {
        // Channel sessions are multi-author: a note posted mid-volley would
        // persist through ChannelSessionManager.appendMessage, which stamps
        // author = the SPEAKING AGENT — the user's words would project as
        // the agent's forever. Refuse until origin-aware channel notes are
        // designed (channel-store CHANNEL_ID_RE).
        if (/^chan-[0-9a-f]{8}$/.test(msg.sessionId)) {
          ws.send(JSON.stringify({
            type: "note_rejected",
            sessionId: msg.sessionId,
            reason: "Notes aren't supported in channels yet.",
          }));
          return;
        }
        // Notes are steering remarks folded verbatim into the transcript —
        // cap them well below the chat-content cap.
        const note = msg.content?.trim() ?? "";
        if (note.length > 16 * 1024) {
          ws.send(JSON.stringify({
            type: "note_rejected",
            sessionId: msg.sessionId,
            reason: "Note too long — send it as a regular message.",
          }));
          return;
        }
        if (note && postTurnNote(msg.sessionId, note)) {
          ws.send(JSON.stringify({ type: "note_queued", sessionId: msg.sessionId }));
        } else {
          ws.send(JSON.stringify({
            type: "note_rejected",
            sessionId: msg.sessionId,
            reason: note
              ? "No turn is running in this session — send it as a regular message."
              : "Empty note.",
          }));
        }
        return;
      }

      // Realtime call messages (call_start / call_audio / call_text /
      // call_interrupt / call_end) are handled in call-bridge.ts;
      // routeCallMessage returns true when it consumed the message.
      if (routeCallMessage(ws, msg, config, realtimeManager)) return;

      // [channel] bolt-on: channel_message / channel_stop are handled in
      // channel-bridge.ts; routeChannelMessage returns true when it consumed
      // the message. Mirrors the routeCallMessage hook directly above.
      // localModelManager rides along so a local-default agent can speak.
      if (routeChannelMessage(ws, msg, config, registry, { localModelManager })) return;

      // Deck assist: assist_message runs an embedded helper turn against the
      // open systems-deck artifact (assist.ts). Same consumed-or-not hook.
      if (routeAssistMessage(ws, msg, config, registry, { localModelManager })) return;

      // Replay: re-synthesize a piece of text using the agent's voice.
      // Skips the agent loop entirely. Doesn't take the session lock —
      // user can replay past messages without blocking new ones.
      //
      // FIRE-AND-FORGET: don't `await` here, so this handler returns
      // immediately and the synth pipeline runs alongside later messages
      // (`replay_stop`, other speaker clicks). NOTE: WS message handlers
      // run CONCURRENTLY (Bun does NOT serialize them per-connection —
      // verified empirically) — any guard against double-handling must be
      // installed synchronously before the first await.
      if (msg.type === "replay" && msg.agentId && msg.text && msg.replayId) {
        handleReplay(ws, msg, config, voiceManager).catch((err) => {
          console.warn(`[MANTLE:voice] replay ${msg.replayId} threw:`, err);
        });
        return;
      }
      if (msg.type === "replay_stop" && msg.replayId) {
        stopReplay(msg.replayId);
        return;
      }
      // Per-turn TTS log: client sends back playback timing for each chunk
      // after onPlaybackComplete. We merge into the log we kept alive
      // since tts_done, then finalize (writes the log file).
      if (msg.type === "tts_playback_report" && typeof msg.synthId === "string" && Array.isArray(msg.playbackChunks)) {
        applyPlaybackReport(msg.synthId, msg.playbackChunks, ws);
        return;
      }

      const isRetry = msg.type === "retry";
      const isMessage = msg.type === "message";

      if (!isMessage && !isRetry) {
        ws.send(JSON.stringify({ type: "error", error: "Invalid message type" }));
        return;
      }

      if (!msg.sessionId) {
        ws.send(JSON.stringify({ type: "error", error: "Missing sessionId" }));
        return;
      }

      if (isMessage && !msg.content && !msg.attachments?.length) {
        ws.send(JSON.stringify({ type: "error", error: "Empty message" }));
        return;
      }

      // Default agent if not specified
      if (!msg.agentId) {
        msg.agentId = config.defaultAgent;
      }

      // Validate agent exists
      const agent = getAgent(config, msg.agentId);
      if (!agent) {
        ws.send(JSON.stringify({ type: "error", error: `Unknown agent: ${msg.agentId}` }));
        return;
      }

      // Prevent concurrent loops on the same session. A plain text message
      // into a busy session becomes a steer-while-busy NOTE instead of a
      // refusal — the running turn folds it in at its next iteration.
      // Attachments and retries still get the busy error: those need a full
      // turn of their own.
      const sessionKey = `${msg.agentId}:${msg.sessionId}`;
      if (activeSessions.has(sessionKey)) {
        if (
          isMessage &&
          msg.content?.trim() &&
          msg.content.length <= 16 * 1024 && // same cap as explicit notes
          !msg.attachments?.length &&
          postTurnNote(msg.sessionId, msg.content.trim())
        ) {
          ws.send(JSON.stringify({ type: "note_queued", sessionId: msg.sessionId }));
          return;
        }
        ws.send(JSON.stringify({ type: "error", error: "Session is busy — wait for the current response to finish" }));
        return;
      }

      // Agent-level lock via the shared idiom: owner "chat" preempts any
      // lower-ranked holder (heartbeat/cron/channel/…); another chat keeps
      // the lock and we busy-refuse. The controller withAgentLock hands us
      // doubles as /stop's handle AND the lock's abort callback, so agent
      // purge / shutdown (abortAgentLock) can cut an in-flight chat turn —
      // nothing outranks chat, so preemption itself never fires it.
      // RACE NOTE: the path from the activeSessions check above to the
      // add() below is fully synchronous (withAgentLock's preempt path has
      // no awaits before fn runs), which is what keeps the session guard
      // sound under Bun's concurrent WS handlers.
      const locked = await withAgentLock(
        msg.agentId,
        { owner: "chat", policy: "preempt-lower" },
        async (controller) => {
          activeSessions.add(sessionKey);
          activeControllers.set(sessionKey, controller);
          try {
            if (isRetry) {
              await handleChat(ws, msg, config, registry, controller.signal, backgroundRunner, voiceManager, subagentManager, localModelManager, integrations, { retry: true });
            } else {
              await handleChat(ws, msg, config, registry, controller.signal, backgroundRunner, voiceManager, subagentManager, localModelManager, integrations);
            }
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error(`[MANTLE:ws] Error in handleChat:`, errorMsg);
            try {
              ws.send(JSON.stringify({ type: "error", error: errorMsg }));
            } catch {
              // WebSocket may have closed
            }
          } finally {
            activeSessions.delete(sessionKey);
            activeControllers.delete(sessionKey);
          }
        },
      );
      if (!locked.ok) {
        ws.send(JSON.stringify({ type: "error", error: "Agent is busy — wait for the current response to finish" }));
      }
    },

    close(ws: ServerWebSocket<WsData>) {
      console.log("[MANTLE:ws] Client disconnected");
      unregisterWebSocket(ws);
      // Stop this connection's voice replays — nobody is listening, and the
      // synth pipeline would otherwise burn GPU into a dead socket.
      abortReplaysForWs(ws);
      // End any in-flight realtime calls this WS owns (frees the xAI
      // socket + its meter). See call-bridge.ts.
      closeCallsForWs(ws, realtimeManager);
    },
  };
}

// Memory pack lives in src/agent/memory-pack.ts — buildMemoryPack and
// findPriorTurnTexts are imported at the top of this file. The replay
// subsystem (handleReplay + its abort registries) lives in replay.ts.

async function handleChat(
  ws: ServerWebSocket<WsData>,
  msg: ClientMessage,
  config: MantleConfig,
  registry: ToolRegistry,
  signal?: AbortSignal,
  backgroundRunner?: import("../agent/background-runner.js").BackgroundTaskRunner,
  voiceManager?: VoiceManager,
  subagentManager?: import("../agent/subagent-manager.js").SubagentManager,
  localModelManager?: LocalModelManager,
  integrations?: IntegrationRegistry,
  opts?: { retry?: boolean },
) {
  const agent = getAgent(config, msg.agentId)!;
  const baseMantleDir = resolve(config.basePath, ".mantle");
  const sessionsDir = resolve(baseMantleDir, "sessions", agent.id);
  const session = new SessionManager(msg.sessionId, sessionsDir);
  const isRetry = opts?.retry === true;

  // Resolve this session's index entry ONCE — the fields read below
  // (sub-agent metadata and last-message persona) are fixed at creation or
  // only change between turns.
  const turnSessionMeta = SessionManager.loadIndex(sessionsDir).sessions.find(
    (s) => s.id === msg.sessionId,
  );
  const turnSubagentDepth = turnSessionMeta?.subagentDepth ?? 0;
  const turnParentSessionId = turnSessionMeta?.parentSessionId;

  // Retry path: rewind the transcript to the last real user turn so the
  // loop re-runs on the same prompt instead of appending a new one.
  // We rebuild memoryPack against that rewound user message below.
  let retryUserContent = "";
  if (isRetry) {
    const keptIdx = await session.truncateAfterLastUserText();
    if (keptIdx === -1) {
      ws.send(JSON.stringify({ type: "error", error: "Nothing to retry — no prior user message in this session" }));
      return;
    }
    const all = await session.getMessages();
    const lastUser = all[all.length - 1];
    const textBlock = lastUser?.content.find(
      (b): b is Extract<MessageContent, { type: "text" }> => b.type === "text",
    );
    retryUserContent = textBlock?.text ?? "";
  }

  // Select the backend + model for this turn. resolveProviderTurn folds in the
  // legacy-name migration, the grok-build model-routing override, and the
  // local-model fallback that used to live inline here — and now applies them
  // uniformly across every dispatch site, not just chat.
  const resolved = resolveProviderTurn(config, { localModelManager }, {
    requestedProvider: msg.provider,
    requestedModel: msg.model,
    agentDefaultProvider: agent.defaultProvider,
    agentDefaultModel: agent.defaultModel,
    globalDefaultProvider: config.defaultProvider,
  });
  if (!resolved.ok) {
    ws.send(JSON.stringify({ type: "error", error: resolved.error }));
    return;
  }
  const { provider, model, vendor, backendId } = resolved;

  // Context gauge inputs for THIS turn's model, resolved once: the window
  // ceiling (off provider.name, so the Codex/API gpt-5.x split is right) and
  // the compaction threshold — a fraction (0.6) of that window, so it fires at
  // 60% full for every model. Both ride the message_end event so the UI's gauge
  // tracks the model that actually ran instead of guessing from a static map.
  const turnContextWindow = resolveContextWindow(provider.name, model, config);
  const turnCompactionThreshold = effectiveCompactionThreshold(turnContextWindow, config);

  // Surface the actual backend + model being called so model-self-ID
  // mismatches (a known model quirk — Claude often calls itself
  // "Sonnet 3.5" regardless of which one is actually serving) are easy
  // to disambiguate from real wrong-model bugs.
  console.log(`[MANTLE:ws] turn → backend=${backendId} model=${model} (msg.model=${msg.model ?? "—"} agent.defaultModel=${agent.defaultModel ?? "—"})`);

  // Build user message content blocks (skip on retry — we re-use the
  // existing prior user turn that truncateAfterLastUserText() preserved)
  if (!isRetry) {
    // Edit flow: drop the prior user turn (and everything after it)
    // before appending the edited replacement. The UI removes those
    // bubbles from the DOM at click time, so server + client stay in
    // sync. No-op if there's no prior user turn (e.g., edit fired on an
    // empty session — shouldn't happen in practice but guarded anyway).
    if (msg.edit) {
      await session.dropLastUserAndAfter();
    }

    const userContent: MessageContent[] = [];

    if (msg.content?.trim()) {
      userContent.push({ type: "text", text: msg.content });
    }

    // Resolve file attachments into content blocks
    if (msg.attachments?.length) {
      for (const fileId of msg.attachments) {
        const meta = getFileMetadata(baseMantleDir, agent.id, msg.sessionId, fileId);
        if (!meta) continue;

        if (meta.category === "image") {
          userContent.push({
            type: "image",
            fileId: meta.fileId,
            mediaType: meta.mediaType,
            filename: meta.originalName,
            size: meta.size,
          });
        } else {
          userContent.push({
            type: "file",
            fileId: meta.fileId,
            mediaType: meta.mediaType,
            filename: meta.originalName,
            size: meta.size,
            extractedText: meta.extractedText,
          });
        }
      }
    }

    // Append user message to session
    await session.appendMessage({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      role: "user",
      content: userContent,
    });
  }

  await compactIfNeeded({
    session,
    provider,
    model,
    threshold: turnCompactionThreshold,
    signal,
  });

  // Skills are resolved inside the front door; runTriggeredAgentTurn loads and
  // filters them for the selected provider turn.

  // Load persona data if available
  const personasConfig = loadPersonas(agent.workspace);
  const requestedPersona = msg.persona ?? personasConfig?.currentState;
  let personaOpts: { name: string; profile: PersonaProfile } | undefined;
  let transitionOpts: { from: string; to: string } | undefined;

  if (personasConfig && requestedPersona && personasConfig.profiles[requestedPersona]) {
    personaOpts = {
      name: requestedPersona,
      profile: personasConfig.profiles[requestedPersona],
    };

    // Check for persona transition — compare against the persona that was
    // active during the last message send, not the current UI selection.
    // This way toggling personas without sending a message doesn't trigger
    // a transition acknowledgment. (Read from the turn-top index snapshot —
    // lastMessagePersona only changes via the write right below.)
    const previousPersona = turnSessionMeta?.lastMessagePersona;

    if (previousPersona && previousPersona !== requestedPersona) {
      transitionOpts = { from: previousPersona, to: requestedPersona };
    }

    // Update both the display persona and the last-sent persona
    mutateSessionIndex(sessionsDir, (index) => {
      const sessionMeta = index.sessions.find((s) => s.id === msg.sessionId);
      if (!sessionMeta) return false;
      sessionMeta.persona = requestedPersona;
      sessionMeta.lastMessagePersona = requestedPersona;
    });
  }

  // Pre-inference memory pack: run englyph_search against the user's
  // current message PLUS the prior assistant response and prior user
  // turn (when available) as multi-source query material; assemble a
  // "recalled memories" block that goes into the system prompt's
  // dynamic zone. Multi-source retrieval handles "dig deeper" / "tell
  // me more" follow-ups where the current user turn alone has too
  // little topical signal — the prior assistant response is closer to
  // memory framing than user-speak and re-surfaces what was just
  // discussed. This is the replacement for the in-loop `recall` tool
  // pattern — memory arrives in context before inference starts, the agent
  // treats it as background knowledge, no mid-turn round-trip needed.
  // Best-effort: any failure falls through silently and the turn
  // proceeds with no pack (existing behavior).
  //
  // Skipped entirely when the client sends `memoryPack: false` — used
  // by the in-app toggle to run a turn without per-message recall.
  // Englyph, MEMORY.md, ingestion, and mining are unaffected.
  const sessionMessages = await session.getMessages();
  const priorContext = findPriorTurnTexts(sessionMessages);
  // Gate on the englyph tools actually being registered: when the daemon was
  // unreachable at boot the englyph_* tools were never bridged, so building the
  // pack would just fire dead `registry.execute` calls. `signal` lets /stop and
  // the budget abort the pack mid-flight.
  const memoryPack = msg.memoryPack === false || !registry.has("englyph_search_batch")
    ? undefined
    : await buildMemoryPack(
        registry,
        isRetry ? retryUserContent : (msg.content ?? ""),
        agent.id,
        priorContext,
        signal,
      );

  // ── Voice mode setup ─────────────────────────────────────────────────
  // Only enabled when: (1) the user requested it, (2) the chosen provider
  // is viable for this server+agent (chatterbox = sidecar alive + voice
  // file present; xAI = Grok API key configured). Falsy on any miss —
  // the rest of handleChat behaves identically to a non-voice turn, the
  // prompt block simply isn't added and no synth pipeline runs.
  const voiceWanted = msg.voiceMode === true;
  const voiceProvider: VoiceProvider = msg.voiceProvider ?? "chatterbox";
  const providerViable = voiceWanted && (
    voiceProvider === "xai"
      ? !!config.providers.grok.apiKey
      : voiceManager?.isAlive() === true
  );
  // The turn's abort signal rides into the pipeline so /stop actually
  // stops TTS (aborts in-flight synth + skips queued chunks) instead of
  // letting flushAndWait hold the session slot for the buffered tail.
  const voicePipeline = providerViable
    ? buildVoicePipeline(voiceProvider, ws, config, voiceManager, agent.id, signal)
    : null;
  const voiceModeActive = voicePipeline !== null;

  // Tell the UI up-front whether voice will be active for this turn so it
  // can switch text rendering into audio-gated mode. tts_unavailable lets
  // the UI fall back to normal text streaming if the user requested voice
  // but the server can't deliver (sidecar down, no voice file).
  if (voiceWanted) {
    try {
      if (voicePipeline) {
        ws.send(JSON.stringify({ type: "tts_start", synthId: voicePipeline.synthId }));
      } else {
        ws.send(JSON.stringify({ type: "tts_unavailable" }));
      }
    } catch { /* ws closed */ }
  }

  // Per-turn cache for resolved attachment bytes — resolveAttachmentsForProvider
  // runs on every loop iteration; without this it re-reads + re-base64s each
  // image/PDF from disk every pass. Bytes are immutable, so cache by fileId for
  // the life of the turn (GC'd when this handler returns).
  const attachmentBase64Cache = new Map<string, string>();

  // Run the turn through the SHARED front door (runTriggeredAgentTurn) —
  // the same spin-up heartbeat/cron/channel/deliveries use. Chat gains the
  // front door's pinned ToolContext (per-agent isolation is structural, not
  // hand-assembled here) and stops drifting from the other dispatch sites.
  // Chat-specific flavor rides the hooks:
  //   - promptExtras keeps persona a separate CACHEABLE zone + carries the
  //     transition note, memory pack, and voice-mode flag;
  //   - toolFilter applies chat's DENY-list (raw englyph_* hidden; remember +
  //     recall_source hidden — authoring is the archivist's job, source is
  //     being redone; MANTLE_DISABLE_MEMORY_TOOLS=1 hides the whole memory
  //     surface for pack-isolation testing). Tools stay REGISTERED either
  //     way — the pack builder + archivist still call them internally.
  // Caller-side by the front door's contract: compaction, retry/edit surgery,
  // attachment assembly, memory-pack build, voice lifecycle, persona index
  // writes.
  // chat-tool-surface.ts owns the hide policy (raw englyph_* + remember +
  // recall_source); MANTLE_DISABLE_MEMORY_TOOLS hides the whole memory surface
  // for pack-isolation testing. The /api/tools surface reads the SAME policy so
  // the Tools deck shows the agent's real surface, not the raw registry.
  const disableMemoryToolsForAgent = process.env.MANTLE_DISABLE_MEMORY_TOOLS === "1";

  // Per-agent integration visibility: hide tools for integrations this agent
  // hasn't connected (and write tools when the connection lacks write scope).
  // Composed HERE at the server layer because the agent loop can't import
  // integrations/ (check:arch) — the gate rides the existing chat toolFilter.
  const hiddenIntegrationTools = new Set(integrations?.hiddenToolNames(agent.id) ?? []);

  // try/finally around turn + flush: a throw must still flush the voice
  // pipeline — flushAndWait is what schedules the turn log's finalize, so
  // skipping it leaked the activeVoiceLogs entry (and left the client
  // without a tts_done).
  try {
  const turn = await runTriggeredAgentTurn({
    config,
    registry,
    deps: { localModelManager },
    agentId: agent.id,
    session,
    signal,
    providerSelection: {
      requestedProvider: msg.provider,
      requestedModel: msg.model,
    },
    promptExtras: {
      persona: personaOpts,
      personaTransition: transitionOpts,
      memoryPack,
      voiceMode: voiceModeActive,
    },
    toolFilter: (defs) => defs.filter((t) => !chatToolHidden(t.name, disableMemoryToolsForAgent) && !hiddenIntegrationTools.has(t.name)),
    toolContextExtra: {
      backgroundRunner,
      subagentManager,
      subagentDepth: turnSubagentDepth,
      parentSessionId: turnParentSessionId,
    },
    thinkingLevel: coerceThinkingLevel(msg.thinkingLevel),
    fastMode: msg.fastMode === true ? true : undefined,
    transformMessages: async (messages) => {
      return resolveAttachmentsForProvider(
        messages,
        vendor,
        baseMantleDir,
        agent.id,
        msg.sessionId,
        attachmentBase64Cache,
      );
    },
    onEvent: (event: AgentStreamEvent) => {
      // Voice mode taps text deltas to feed the chunker and triggers
      // a flush at message_end. Everything else just forwards verbatim
      // — text rendering in the UI continues to work normally and the
      // tts_audio events arrive interleaved.
      if (voicePipeline) {
        if (event.type === "text_delta") voicePipeline.feed(event.text);
      }
      try {
        // message_end carries the gauge's window + compaction threshold for
        // the model that actually ran (computed once above).
        if (event.type === "message_end") {
          ws.send(JSON.stringify({ ...event, contextWindow: turnContextWindow, compactionThreshold: turnCompactionThreshold }));
        } else {
          ws.send(JSON.stringify(event));
        }
      } catch {
        // WebSocket might have closed during streaming
      }
    },
  });

  if (!turn.ok) {
    ws.send(JSON.stringify({ type: "error", error: turn.error }));
    return;
  }
  const outcome = turn.outcome;
  console.log(
    `[MANTLE:ws] turn done → ${outcome.stopCause} (${outcome.iterations} iter, ` +
    `${outcome.usage.inputTokens}in/${outcome.usage.outputTokens}out` +
    `${outcome.detections.length ? `, detections: ${outcome.detections.join(",")}` : ""})`,
  );
  } finally {
    // Drain any remaining buffered text and wait for all in-flight synth
    // calls to complete + their audio chunks to land on the wire. Keeps
    // the activeSessions slot held until the audio is fully delivered, so
    // the next user turn can't preempt the tail of TTS. Runs even when the
    // loop threw — finalize scheduling (and the activeVoiceLogs entry's
    // lifecycle) depend on it.
    if (voicePipeline) {
      try {
        await voicePipeline.flushAndWait();
      } catch (err) {
        console.warn(`[MANTLE:voice] flushAndWait failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
