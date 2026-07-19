// Channel turn bridge — the server controller for the multi-agent group-chat
// feature. Sits between the browser WebSocket and a real runAgentLoop run.
// Mirrors call-bridge.ts's shape: routeChannelMessage(ws, msg, deps) is a
// consume-or-passthrough router (returns true when it handled a channel_*
// message), and runChannelTurn is the controller it dispatches to.
//
// Routing model: the server builds an OPENING speaker queue from the user
// message (server-authoritative) via resolveOpeningQueue — the live-mic
// (auto-respond) agents first in roster order, then explicit @mentions not
// already queued, else the last-active agent, else empty → "@someone" notice.
// The queue runs STRICTLY SEQUENTIALLY: each speaker's full sub-turn finishes —
// and its reply is stamped onto the shared transcript — before the next runs.
// Because the POV transform re-reads the transcript from disk per sub-turn,
// speaker N sees speakers 1..N-1's just-posted replies. Each speaker gets a
// DISTINCT turnSeq so the UI keys its bubble; ONE channel_turn_complete fires
// after the whole volley settles. The re-entrancy guard wraps the WHOLE turn.
//
// VOLLEY ("riff"): when meta.volley.enabled, once the opening queue drains the
// controller keeps extending it agent→agent — "free" style hands the floor to
// whoever the last reply @-mentions (else rotates), "round-robin" style just
// rotates through the live mics — until `maxTurns` agent turns have run since
// the user's message (hard-bounded by VOLLEY_CAP) or every live mic has called
// channel_yield to pass. A channel_volley_state event feeds the UI's turn HUD;
// the "Jump in" button is just a channel_stop that aborts the in-flight riff.
//
// Everything reuses the core unchanged: buildSystemPrompt, resolveProviderTurn,
// runAgentLoop, SessionManager, the ToolRegistry. The only channel-specific
// glue is the system-prompt block (composeChannelSystemPrompt), the POV
// transcript transform, and the injected channel_yield pseudo-tool.

import type { ServerWebSocket } from "bun";
import type { MantleConfig } from "../../config/schema.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { getAgent } from "../../config/loader.js";
import type { AgentStreamEvent } from "../../agent/loop.js";
import { runTriggeredAgentTurn, type PseudoTool } from "../../agent/triggered-turn.js";
import type { BackendDeps } from "../../agent/providers/catalog.js";
import { withAgentLock } from "../../agent/agent-lock.js";
import { getUserName } from "../../agent/prompt-builder.js";
import { ChannelStore, isValidChannelId } from "./channel-store.js";
import { ChannelSessionManager } from "./channel-session.js";
import { projectForAgent } from "./pov.js";
import { composeChannelSystemPrompt } from "./channel-prompt.js";
import {
  resolveOpeningQueue,
  nextRoundRobinSpeaker,
  parseMentions,
  stripLeadingSelfPrefix,
} from "./mentions.js";
import {
  CHANNEL_TOOL_NAMES,
  CHANNEL_WEB_TOOL_NAMES,
  CHANNEL_YIELD_TOOL,
  CHANNEL_REACT_TOOL,
  VOLLEY_CAP,
  type ChannelMessage,
  type ChannelMeta,
  type ChannelParticipant,
  type ChannelVolley,
  type ChannelWhisper,
} from "./types.js";
import { buildMemoryPack, type PriorTurnTexts } from "../../agent/memory-pack.js";

// The slice of the WS wire shape the channel consumes. Declared HERE (not
// imported from server/ws-types) so the room never imports src/server —
// ws.ts's ClientMessage is a structural superset and passes straight in.
export interface ChannelInboundMessage {
  type: string;
  channelId?: string;
  content?: string;
  channelClientId?: string;
  // Private aside: agent ids the user is whispering to. ws.ts validates the
  // wire shape (string array, SAFE_ID, capped); the bridge intersects it with
  // the live roster before trusting it.
  whisperTo?: string[];
}

// The bridge never reads ws.data — any Bun socket works.
type ChannelWs = ServerWebSocket<unknown>;

// Per-channel re-entrancy guard. A channel runs at most ONE turn at a time;
// a second channel_message while one is in flight is refused with a system
// notice. The AbortController lets channel_stop cancel the in-flight turn.
// NOTE: WS handlers run CONCURRENTLY (Bun does NOT serialize them per
// connection) — the has-check → set window stays race-free only because the
// path from routeChannelMessage to the .set() below is fully synchronous
// (async functions run synchronously to their first await). Keep it that way.
const activeChannelTurns = new Map<string, AbortController>();

// Abort one channel's in-flight turn (channel_stop, channel DELETE). Returns
// whether anything was actually running.
export function abortChannelTurn(channelId: string): boolean {
  const controller = activeChannelTurns.get(channelId);
  if (!controller) return false;
  controller.abort();
  return true;
}

// Abort every in-flight channel volley — shutdown's counterpart to
// abortAllActiveTurns, so englyph/MCP/voice teardown doesn't yank deps out
// from under a still-streaming speaker.
export function abortAllChannelTurns(): number {
  let count = 0;
  for (const controller of activeChannelTurns.values()) {
    try { controller.abort(); count++; } catch { /* already aborted */ }
  }
  return count;
}

// Max agent-loop iterations for a channel sub-turn. A hangout reply is short
// and conversational — a handful of recall calls at most — so a tight cap
// keeps a stuck model from grinding (the in-process cap is 100 for full chat).
const CHANNEL_MAX_ITERATIONS = 6;

// Validate a client-supplied message id before trusting it as a transcript row
// id (reactions key off it). Anything malformed falls back to a server-minted id.
function isUuid(s: string | undefined): boolean {
  return typeof s === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// Route a channel_* message. Returns true when the message was a channel type
// (and was handled here), false otherwise so the caller keeps dispatching.
// Mirrors routeCallMessage in call-bridge.ts. Fire-and-forget on the turn so
// this handler returns immediately and later frames (channel_stop, other
// sessions' traffic) aren't queued behind a multi-minute volley.
export function routeChannelMessage(
  ws: ChannelWs,
  msg: ChannelInboundMessage,
  config: MantleConfig,
  registry: ToolRegistry,
  deps: BackendDeps = {},
): boolean {
  if (msg.type !== "channel_message" && msg.type !== "channel_retry" && msg.type !== "channel_stop") {
    return false;
  }
  // The id comes off the wire and becomes a filesystem path in ChannelStore —
  // refuse anything that isn't the exact shape the store mints before any
  // store call happens (the store's channelDir throws as a backstop).
  if (!msg.channelId || !isValidChannelId(msg.channelId)) {
    if (msg.channelId) sendSystem(ws, msg.channelId, `Unknown channel: ${msg.channelId}`);
    return true;
  }
  if (msg.type === "channel_message") {
    runChannelTurn(ws, msg.channelId, msg.content ?? "", config, registry, deps, {
      clientMsgId: msg.channelClientId,
      whisperTo: msg.whisperTo,
    }).catch((err) => {
      console.warn(
        `[MANTLE:channel] turn for ${msg.channelId} threw: ${err instanceof Error ? err.message : err}`,
      );
    });
    return true;
  }
  if (msg.type === "channel_retry") {
    retryChannelTurn(ws, msg.channelId, config, registry, deps).catch((err) => {
      console.warn(
        `[MANTLE:channel] retry for ${msg.channelId} threw: ${err instanceof Error ? err.message : err}`,
      );
    });
    return true;
  }
  abortChannelTurn(msg.channelId);
  return true;
}

// Resolve the participant blurbs for the "who else is here" prompt block —
// every active participant EXCEPT the speaker, as ChannelParticipant. In P2
// this is genuinely populated (multiple agents can be in the roster), so the
// speaking agent's prompt actually lists who else is present and the
// @-etiquette is meaningful.
function describeOthers(
  config: MantleConfig,
  participantIds: string[],
  selfId: string,
): ChannelParticipant[] {
  const out: ChannelParticipant[] = [];
  for (const id of participantIds) {
    if (id === selfId) continue;
    const agent = getAgent(config, id);
    if (!agent) continue;
    out.push({ id: agent.id, name: agent.name });
  }
  return out;
}

function sendSystem(ws: ChannelWs, channelId: string, text: string): void {
  try {
    ws.send(JSON.stringify({ type: "channel_system", channelId, text }));
  } catch {
    /* ws closed */
  }
}

// Join a channel row's text blocks (the pack inputs only need plain text).
function rowText(row: ChannelMessage): string {
  const parts: string[] = [];
  for (const b of row.content) if (b.type === "text" && b.text.trim()) parts.push(b.text);
  return parts.join("\n");
}

// Assemble the memory-pack inputs for a speaker from the shared transcript:
// the QUERY is the newest non-self row's text (whatever this speaker is
// answering — the user or another agent), and the prior-turn context mirrors
// the 1:1 semantics: the user's previous message + the speaker's own last
// reply. Tool rows and empty rows are skipped by the text extraction.
function memoryPackInputs(
  rows: ChannelMessage[],
  selfId: string,
): { query: string; prior: PriorTurnTexts } {
  let query = "";
  let priorAssistantText: string | undefined;
  let priorUserText: string | undefined;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const isSelf = row.author?.kind === "agent" && row.author.agentId === selfId;
    const text = rowText(row);
    if (!text) continue;
    if (!query) {
      if (isSelf) continue; // own trailing rows aren't what we're answering
      query = text;
      continue;
    }
    if (isSelf && row.role === "assistant" && !priorAssistantText) priorAssistantText = text;
    else if (row.author?.kind === "user" && !priorUserText) priorUserText = text;
    if (priorAssistantText && priorUserText) break;
  }
  return { query, prior: { priorAssistantText, priorUserText } };
}

// The controller: append the user message, then drain the @-mention speaker
// QUEUE against the shared transcript. The re-entrancy guard + a single
// AbortController (installed inside drainSpeakers) wrap the WHOLE multi-speaker
// turn (a channel_stop aborts every remaining speaker). ONE
// channel_turn_complete fires after the queue drains.
export async function runChannelTurn(
  ws: ChannelWs,
  channelId: string,
  content: string,
  config: MantleConfig,
  registry: ToolRegistry,
  deps: BackendDeps,
  opts?: { clientMsgId?: string; whisperTo?: string[] },
): Promise<void> {
  // Re-entrancy: refuse a concurrent turn on the same channel. The guard wraps
  // the ENTIRE multi-speaker turn — a second channel_message mid-queue is
  // refused, not interleaved. Checked HERE (before the user row is appended)
  // so a refused turn doesn't even persist a row.
  if (activeChannelTurns.has(channelId)) {
    sendSystem(ws, channelId, "This channel is busy — wait for the current reply to finish.");
    return;
  }

  const store = new ChannelStore(config.basePath);

  // Existence check BEFORE the user row is appended — appendMessage mkdirs the
  // channel dir, so appending first would resurrect an orphan dir for a
  // deleted/unknown channel.
  const meta = store.get(channelId);
  if (!meta) {
    sendSystem(ws, channelId, `Unknown channel: ${channelId}`);
    return;
  }

  // Reject an empty/whitespace frame at the server boundary (the client guards
  // too, but the server stays authoritative). Without a fresh user row a
  // live-mic / last-active agent would otherwise reply to stale context. Still
  // emit channel_turn_complete so a direct client's composer (disabled on send)
  // re-enables instead of hanging.
  if (!content.trim()) {
    sendSystem(ws, channelId, "Say something to start a turn.");
    try {
      ws.send(
        JSON.stringify({
          type: "channel_turn_complete",
          channelId,
          lastActiveAgentId: meta.lastActiveAgentId,
        }),
      );
    } catch {
      /* ws closed */
    }
    return;
  }

  // Private aside: intersect the requested whisper set with the live roster
  // (case-insensitive, canonical ids out) BEFORE the row is appended. An
  // empty intersection refuses the turn rather than silently going public —
  // the user asked for privacy; surprising them is the one wrong answer.
  let whisper: ChannelWhisper | undefined;
  if (opts?.whisperTo && opts.whisperTo.length > 0) {
    const wanted = new Set(opts.whisperTo.map((s) => s.toLowerCase()));
    const to = meta.participants.filter((p) => wanted.has(p.toLowerCase()));
    if (to.length === 0) {
      sendSystem(ws, channelId, "Nobody to whisper to — none of the chosen agents are in this channel.");
      try {
        ws.send(JSON.stringify({ type: "channel_turn_complete", channelId, lastActiveAgentId: meta.lastActiveAgentId }));
      } catch {
        /* ws closed */
      }
      return;
    }
    whisper = { to };
  }

  // Append the user's message to the shared transcript FIRST (author: user),
  // so projectForAgent sees it as the opening turn and the POV transform
  // produces strict user/assistant alternation.
  const userRow: ChannelMessage = {
    // Trust a well-formed client-supplied id so the optimistic echo bubble and
    // the persisted row share an id (reactions target it pre-reload); otherwise
    // mint one server-side.
    id: isUuid(opts?.clientMsgId) ? (opts?.clientMsgId as string) : crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    role: "user",
    content: [{ type: "text", text: content }],
    author: { kind: "user" },
    ...(whisper ? { whisper } : {}),
  };
  store.appendMessage(channelId, userRow);

  await drainSpeakers(ws, channelId, content, store, config, registry, deps, whisper);
}

// Channel RETRY: re-run the LAST user message exactly like the 1:1 /retry
// (which truncates after the last real user turn and reuses it). Drop every
// agent reply from the prior attempt (KEEP the user row), re-parse its
// @mentions, and drain the freshly-resolved queue — WITHOUT appending a
// duplicate user row. Shares the SAME re-entrancy guard + AbortController as a
// normal turn (cannot retry while a turn runs). If there is no user row to
// retry, emit a "nothing to retry" notice and return.
export async function retryChannelTurn(
  ws: ChannelWs,
  channelId: string,
  config: MantleConfig,
  registry: ToolRegistry,
  deps: BackendDeps,
): Promise<void> {
  if (activeChannelTurns.has(channelId)) {
    sendSystem(ws, channelId, "This channel is busy — wait for the current reply to finish.");
    return;
  }

  const store = new ChannelStore(config.basePath);
  if (!store.get(channelId)) {
    sendSystem(ws, channelId, `Unknown channel: ${channelId}`);
    return;
  }
  const kept = store.truncateAfterLastUser(channelId);
  if (kept === null) {
    sendSystem(ws, channelId, "Nothing to retry — no message has been sent in this channel yet.");
    return;
  }

  // The user row already exists on disk (truncate kept it) — drain WITHOUT
  // appending it again. Its whisper scope (if any) re-routes the retry
  // privately, exactly like the original send.
  await drainSpeakers(ws, channelId, kept.text, store, config, registry, deps, kept.whisper);
}

// Shared queue-resolve + sequential per-speaker loop. Loads meta, validates the
// roster, resolves the @-mention speaker QUEUE from `content`, installs the
// whole-turn AbortController under the re-entrancy guard, runs each queued
// agent's full sub-turn SEQUENTIALLY against the shared transcript (streaming
// wrapped events to the browser), and fires ONE channel_turn_complete after the
// queue drains. The caller is responsible for ensuring the user row that
// `content` came from is already persisted (runChannelTurn appended it;
// retryChannelTurn kept it).
// One pending slot in the speaker queue. `calledInBy` is the NAME of the agent
// whose @-mention handed this speaker the floor (volley free-style only) — it
// renders the "X pulled you into the conversation" prompt block. Speakers
// queued by the user (live mics, user @s, last-active fallback) carry none.
interface QueuedSpeaker {
  id: string;
  calledInBy?: string;
}

async function drainSpeakers(
  ws: ChannelWs,
  channelId: string,
  content: string,
  store: ChannelStore,
  config: MantleConfig,
  registry: ToolRegistry,
  deps: BackendDeps,
  whisper?: ChannelWhisper,
): Promise<void> {
  // Early-out guards must STILL emit channel_turn_complete: the UI disables the
  // composer on send/retry and only re-enables it on turn_complete, so a bare
  // system notice here would leave the composer stuck disabled until reload.
  // (Retry makes the empty-queue case reachable — e.g. the only @-mentioned
  // agent was dismissed since the original send.)
  const finishEarly = (text: string, lastActiveAgentId?: string) => {
    sendSystem(ws, channelId, text);
    try {
      ws.send(JSON.stringify({ type: "channel_turn_complete", channelId, lastActiveAgentId }));
    } catch {
      /* ws closed */
    }
  };

  const meta = store.get(channelId);
  if (!meta) {
    finishEarly(`Unknown channel: ${channelId}`);
    return;
  }

  const participants = meta.participants;
  if (participants.length === 0) {
    finishEarly("No companions are in this channel yet — add one to start talking.", meta.lastActiveAgentId);
    return;
  }

  // Server-authoritative routing: build the OPENING queue from the user message
  // — the live-mic (auto-respond) agents first in roster order, then explicit
  // @mentions not already queued, else the last-active agent. Volley mode then
  // extends this queue agent→agent as the loop runs (see below).
  //
  // A WHISPER routes only inside its own set: being whispered to IS being
  // addressed, so live mics / last-active never fire — @-mentions within the
  // aside narrow it, otherwise every whispered agent answers.
  const openingIds = whisper
    ? (() => {
        const mentioned = parseMentions(content, whisper.to);
        return mentioned.length > 0 ? mentioned : whisper.to;
      })()
    : resolveOpeningQueue(content, participants, meta.autoRespond, meta.lastActiveAgentId);
  const queue: QueuedSpeaker[] = openingIds.map((id) => ({ id }));
  if (queue.length === 0) {
    finishEarly(
      "@someone to start — mention a companion by id (e.g. @echo), or flip on a live mic in the roster.",
      meta.lastActiveAgentId,
    );
    return;
  }
  // The user's EXPLICIT opening speakers (live mics + @mentions). The volley cap
  // bounds agent↔agent CONTINUATION, not the speakers the user lined up — so all
  // of these always get to run even when openingCount > the configured maxTurns
  // (otherwise @-mentioning 5 agents with maxTurns=3 would silently drop two).
  const openingCount = queue.length;

  // The volley budget. When OFF, there's no continuation — the opening queue
  // drains once and we stop (cap = Infinity is fine: the queue never grows).
  // When ON, control returns to the user after `maxTurns` agent turns since
  // their message (the opening replies count), hard-bounded by VOLLEY_CAP.
  const volley = meta.volley;
  const cap = volley.enabled ? Math.min(volley.maxTurns, VOLLEY_CAP) : Number.POSITIVE_INFINITY;
  // HUD ceiling: the larger of the cap and the explicit opening queue, so the
  // "N turns until your move" meter stays honest during an over-cap opening drain.
  const hudCap = volley.enabled ? Math.max(cap, openingCount) : cap;

  // Install the whole-turn abort BEFORE running any speaker, so channel_stop
  // (incl. the "Jump in" button) cancels the in-flight speaker AND skips the
  // rest. A single controller is shared by every sub-turn's lock callback.
  const abort = new AbortController();
  activeChannelTurns.set(channelId, abort);

  // Track who actually spoke so channel_turn_complete reports the true last
  // active agent (a busy-skipped agent never becomes last-active).
  let lastSpokenId: string | undefined = meta.lastActiveAgentId;
  let turnsUsed = 0;
  // Live mics that have called channel_yield this volley — dropped from the
  // round-robin rotation (a direct @-handoff can still reactivate one).
  const yielded = new Set<string>();
  // Every speaker that actually spoke this volley, in order — the ping-pong
  // guard in pickNextSpeaker reads it so an A↔B @-handoff loop can't ride the
  // "a direct @ revives a yielded agent" rule all the way to the cap.
  const spoken: string[] = [];

  if (volley.enabled) emitVolleyState(ws, channelId, turnsUsed, hudCap, queue[0]?.id);

  try {
    while (queue.length > 0 && !abort.signal.aborted) {
      // Explicit opening speakers always run; the cap only stops volley
      // CONTINUATION (agent↔agent riffing past the user's lined-up queue).
      if (turnsUsed >= cap && turnsUsed >= openingCount) break;
      const next = queue.shift() as QueuedSpeaker;
      const speakerId = next.id;
      const sub = await runSpeakerSubTurn(ws, {
        channelId,
        speakerId,
        calledInBy: next.calledInBy,
        participants,
        config,
        registry,
        deps,
        store,
        meta,
        abort,
        volley,
        whisper,
      });
      // A busy-skip / unknown / backend-fail / errored sub-turn doesn't consume
      // a volley turn and can't drive continuation.
      if (!sub.spoke) continue;
      turnsUsed++;
      lastSpokenId = speakerId;
      spoken.push(speakerId);
      if (sub.yielded) yielded.add(speakerId);

      // Continuation: only once the explicit opening queue has fully drained do
      // we let the volley extend it, so the user's lined-up speakers always go
      // first and in order. The next speaker comes from the last reply (free
      // style: an @-handoff) or the round-robin rotation.
      let nextUp: string | undefined = queue[0]?.id;
      if (volley.enabled && turnsUsed < cap && queue.length === 0 && !abort.signal.aborted) {
        const picked = pickNextSpeaker(volley, meta, speakerId, sub.text, yielded, spoken, config, whisper?.to);
        if (picked) {
          queue.push(picked);
          nextUp = picked.id;
        }
      }
      if (volley.enabled) {
        emitVolleyState(ws, channelId, turnsUsed, hudCap, turnsUsed >= hudCap ? undefined : nextUp);
      }
    }
  } finally {
    activeChannelTurns.delete(channelId);
    // ONE turn-complete after the whole volley settles (re-enables the composer).
    try {
      ws.send(
        JSON.stringify({ type: "channel_turn_complete", channelId, lastActiveAgentId: lastSpokenId }),
      );
    } catch {
      /* ws closed */
    }
  }
}

// Choose the next speaker when the opening queue has drained and the volley is
// still under its turn cap. Free style: the first OTHER participant @-mentioned
// in the last reply takes the floor (a direct call-out even reactivates an
// agent that had yielded); with no @, it falls through to the rotation.
// Round-robin style: always the next live mic in rotation, @-mentions ignored.
// Returns undefined when nobody's eligible (everyone yielded / no live mics) —
// which ends the volley and hands the floor back to the user.
//
// Ping-pong guard (free style only): two agents @-ing each other back and
// forth would otherwise ride the revive rule to the cap every single volley.
// When the @-handoff would complete an A→B→A→B alternation (the last three
// spoken turns + the candidate form a strict 2-cycle), the mention is ignored
// and the floor falls to the rotation instead — mirroring the core
// loop-detector's ping-pong rule. One full exchange each (A,B,A) still flows.
function pickNextSpeaker(
  volley: ChannelVolley,
  meta: ChannelMeta,
  lastSpeakerId: string,
  lastText: string,
  yielded: Set<string>,
  spoken: readonly string[],
  config: MantleConfig,
  // During a whisper the volley riffs INSIDE the aside only: handoffs and the
  // rotation are both constrained to the whispered set, so the riff can't
  // leak the conversation to someone who can't see it.
  allowedIds?: readonly string[],
): QueuedSpeaker | undefined {
  if (volley.style === "free") {
    const n = spoken.length;
    const handoffPool = allowedIds ?? meta.participants;
    for (const id of parseMentions(lastText, handoffPool)) {
      if (id === lastSpeakerId) continue; // no handing the floor to yourself
      const pingPong =
        n >= 3 &&
        id === spoken[n - 2] &&
        spoken[n - 1] === spoken[n - 3] &&
        id !== spoken[n - 1];
      if (pingPong) continue;
      yielded.delete(id); // a direct @ pulls a yielded agent back in
      return { id, calledInBy: getAgent(config, lastSpeakerId)?.name ?? lastSpeakerId };
    }
  }
  const rotationPool = allowedIds
    ? meta.autoRespond.filter((id) => allowedIds.includes(id))
    : meta.autoRespond;
  const rotated = nextRoundRobinSpeaker(rotationPool, lastSpeakerId, yielded);
  return rotated ? { id: rotated } : undefined;
}

// Emit the volley HUD state to the browser: how many agent turns have run, the
// budget, and who's up next (null when the floor is about to return to the
// user). The UI renders "<next> is up · N turns until your move".
function emitVolleyState(
  ws: ChannelWs,
  channelId: string,
  turnsUsed: number,
  maxTurns: number,
  nextUp: string | undefined,
): void {
  try {
    ws.send(
      JSON.stringify({
        type: "channel_volley_state",
        channelId,
        turnsUsed,
        maxTurns,
        remaining: Math.max(0, maxTurns - turnsUsed),
        nextUp: nextUp ?? null,
      }),
    );
  } catch {
    /* ws closed */
  }
}

// Outcome of one speaker's sub-turn, handed back to the volley controller.
//   spoke   — the agent acquired its lock and ran (false on busy-skip / unknown
//             / backend-fail / error, so it doesn't consume a volley turn).
//   text    — the agent's reply text (self-prefix stripped), re-parsed for
//             @-handoffs in "free" style. Empty when it didn't speak.
//   yielded — the agent called channel_yield to pass the floor this round.
interface SubTurnResult {
  spoke: boolean;
  text: string;
  yielded: boolean;
}
const SKIPPED: SubTurnResult = { spoke: false, text: "", yielded: false };

// One speaker's full sub-turn: take its agent lock as owner "channel"
// (preempting background-tier work; busy-skipping a live 1:1 chat — and now
// preemptABLE by one, so the user's direct message always wins), run the turn
// through the shared front door (channel prompt compose + recall-only tools +
// the POV transform + the yield/react pseudo-tools), record the reply, and
// emit the speaker_start / channel_event* / speaker_end cycle with a DISTINCT
// turnSeq. Returns a SubTurnResult so the controller can count turns, route
// the next speaker, and honor a yield. Does NOT touch the re-entrancy map or
// emit channel_turn_complete — the controller owns the whole-turn lifecycle.
async function runSpeakerSubTurn(
  ws: ChannelWs,
  args: {
    channelId: string;
    speakerId: string;
    calledInBy?: string;
    participants: string[];
    config: MantleConfig;
    registry: ToolRegistry;
    deps: BackendDeps;
    store: ChannelStore;
    meta: ChannelMeta;
    abort: AbortController;
    volley: ChannelVolley;
    whisper?: ChannelWhisper;
  },
): Promise<SubTurnResult> {
  const { channelId, speakerId, calledInBy, participants, config, registry, deps, store, meta, abort, volley, whisper } = args;

  const agent = getAgent(config, speakerId);
  if (!agent) {
    sendSystem(ws, channelId, `Channel participant "${speakerId}" is no longer a known agent.`);
    return SKIPPED;
  }

  const locked = await withAgentLock<SubTurnResult>(
    speakerId,
    { owner: "channel", policy: "preempt-lower" },
    async (lockController) => {
      // A preemption of THIS speaker (the user's 1:1 message outranks the
      // channel) stops the WHOLE volley — the user wants the agent now.
      lockController.signal.addEventListener("abort", () => abort.abort());

      // A DISTINCT turnSeq per speaker so the UI keys each bubble separately
      // when N speakers stream back-to-back in one user turn; strictly
      // monotonic per channel so same-millisecond sub-turns never collide.
      const turnSeq = nextTurnSeq(channelId);
      const accentColor = agent.accentColor;

      // The message this speaker is responding to — the newest row BEFORE its
      // own sub-turn starts, and only among rows this speaker can SEE (a
      // public speaker right after an aside must not react to a whisper row
      // it was never shown). Snapshotted here because mid-turn "the last row"
      // becomes the speaker's own in-progress rows (channel_react is a tool
      // call, so by the time it fires the speaker's assistant row is already
      // appended — the old reactToLast made agents react to THEMSELVES).
      const preRows = store.readMessages(channelId);
      const visibleRows = preRows.filter(
        (r) =>
          !r.whisper ||
          (r.author?.kind === "agent" && r.author.agentId === speakerId) ||
          r.whisper.to.includes(speakerId),
      );
      const reactTargetId = visibleRows.length > 0 ? visibleRows[visibleRows.length - 1].id : undefined;

      // A SessionManager pointed at the channel dir — the loop appends the
      // assistant message + tool_result rows through it, and it stamps THIS
      // speaker's author tag (and the aside's whisper scope, when answering
      // one) on every row at append time, so even in-progress rows (and the
      // loop's interrupted-partial persist) are attributable + scoped.
      const channelDir = store.channelDir(channelId);
      const session = new ChannelSessionManager(
        channelId,
        channelDir,
        {
          kind: "agent",
          agentId: speakerId,
          name: agent.name,
          accentColor,
        },
        whisper,
      );

      // Channel pseudo-tools — advertised to the model, intercepted by the
      // front door before the registry. channel_yield only during a volley;
      // channel_react always (reacting to what you're answering is a natural
      // group-chat move).
      let didYield = false;
      const pseudoTools: PseudoTool[] = [];
      if (volley.enabled) {
        pseudoTools.push({
          def: CHANNEL_YIELD_TOOL,
          handle: () => {
            didYield = true;
            return { result: "(You passed the floor for this round.)", status: "ok", isError: false };
          },
        });
      }
      pseudoTools.push({
        def: CHANNEL_REACT_TOOL,
        handle: (input) => {
          const raw = (input as { emoji?: unknown } | null)?.emoji;
          const emoji = typeof raw === "string" ? raw.trim() : "";
          if (emoji && reactTargetId) {
            const res = store.setReaction(channelId, reactTargetId, emoji, speakerId, true);
            if (res) {
              try {
                ws.send(JSON.stringify({
                  type: "channel_reaction",
                  channelId,
                  messageId: res.messageId,
                  reactions: res.reactions,
                }));
              } catch {
                /* ws closed */
              }
            }
          }
          return {
            result: emoji ? `(You reacted ${emoji}.)` : "(No emoji provided — nothing to react with.)",
            status: "ok",
            isError: false,
          };
        },
      });

      // Open the themed bubble + "typing" indicator before the first token.
      // whisperTo lets the UI render the live bubble with the aside treatment.
      try {
        ws.send(
          JSON.stringify({
            type: "channel_speaker_start",
            channelId,
            agentId: speakerId,
            name: agent.name,
            accentColor,
            turnSeq,
            whisperTo: whisper?.to,
          }),
        );
      } catch {
        /* ws closed */
      }

      // Accumulated reply text (for @-handoff re-parsing in "free" style).
      let replyText = "";
      let errored = false;
      let failedCause: string | undefined;
      let persistedMsgId: string | undefined; // the row id, surfaced to the UI for reactions

      // Pre-inference memory pack (per-channel toggle): the same Englyph
      // retrieval the 1:1 chat runs, against THIS speaker's own store, keyed
      // on whatever the speaker is answering. Budgeted + abortable inside
      // buildMemoryPack; a failure degrades to "no pack", never a dead turn.
      let memoryPack: string | undefined;
      if (meta.memoryPack && registry.has("englyph_search_batch")) {
        const inputs = memoryPackInputs(preRows, speakerId);
        if (inputs.query) {
          memoryPack = await buildMemoryPack(registry, inputs.query, speakerId, inputs.prior, abort.signal);
        }
      }

      try {
        // The front door owns backend resolution (honoring the channel's
        // sticky per-agent override, with `deps` carrying localModelManager
        // so local-default agents can speak), the lean channel prompt (skills
        // omitted — a hangout reply doesn't need the catalog), the
        // recall-only tool surface, and the loop call. The POV transform
        // ALWAYS re-projects from the store's author-tagged rows on disk, so
        // speaker N sees speakers 1..N-1's just-posted replies.
        const override = meta.modelOverrides[speakerId];
        const turn = await runTriggeredAgentTurn({
          config,
          registry,
          deps,
          agentId: speakerId,
          session,
          signal: abort.signal,
          providerSelection: {
            requestedProvider: override?.provider,
            requestedModel: override?.model,
          },
          includeSkills: false,
          promptExtras: memoryPack ? { memoryPack } : undefined,
          composeSystemPrompt: (base) =>
            composeChannelSystemPrompt(base, {
              selfName: agent.name,
              userName: getUserName(),
              others: describeOthers(config, participants, speakerId),
              calledInBy,
              // Only describe the riff (and channel_yield) when a volley is live.
              volley: volley.enabled ? { style: volley.style } : undefined,
              webTools: CHANNEL_WEB_TOOL_NAMES.filter((n) => registry.has(n)),
              whisper: whisper
                ? {
                    with: whisper.to
                      .filter((id) => id !== speakerId)
                      .map((id) => getAgent(config, id)?.name ?? id),
                  }
                : undefined,
            }),
          toolAllowList: [...CHANNEL_TOOL_NAMES],
          pseudoTools,
          maxIterations: CHANNEL_MAX_ITERATIONS,
          transformMessages: async () => projectForAgent(store.readMessages(channelId), speakerId),
          onEvent: (event: AgentStreamEvent) => {
            if (event.type === "text_delta") replyText += event.text;
            try {
              ws.send(JSON.stringify({ type: "channel_event", channelId, agentId: speakerId, turnSeq, event }));
            } catch {
              /* ws closed mid-stream */
            }
          },
        });

        if (!turn.ok) {
          errored = true;
          sendSystem(ws, channelId, turn.error);
        } else {
          const oc = turn.outcome;
          // A turn that neither completed nor produced text is a skip — it
          // shouldn't consume a volley turn or drive @-routing off garbage.
          if (oc.stopCause !== "completed" && oc.stopCause !== "aborted" && !replyText.trim()) {
            failedCause = oc.error ?? oc.stopCause;
          }
          // Rows were author-stamped at append time, and the loop persists an
          // interrupted partial itself — so whatever assistant row landed last
          // IS the reply row. Record it unless the speaker was cut before any
          // visible text (then it never really spoke). Guarded on the channel
          // still existing: a DELETE mid-turn aborts us and the dir is gone.
          if ((!abort.signal.aborted || replyText.trim()) && session.lastAssistantRowId && store.get(channelId)) {
            persistedMsgId = session.lastAssistantRowId;
            store.noteAgentReply(channelId, speakerId);
          }
        }
      } catch (err) {
        errored = true;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[MANTLE:channel] sub-turn error for ${channelId}/${speakerId}:`, message);
        try {
          ws.send(
            JSON.stringify({
              type: "channel_event",
              channelId,
              agentId: speakerId,
              turnSeq,
              event: { type: "error", error: message } satisfies AgentStreamEvent,
            }),
          );
        } catch {
          /* ws closed */
        }
      } finally {
        // Close the themed bubble for THIS speaker. The composer stays
        // disabled — the controller re-enables it once with
        // channel_turn_complete after the whole volley settles.
        try {
          ws.send(JSON.stringify({ type: "channel_speaker_end", channelId, agentId: speakerId, turnSeq, messageId: persistedMsgId }));
        } catch {
          /* ws closed */
        }
      }

      // An errored / failed turn produced no usable reply — treat it like a
      // skip. An aborted sub-turn that streamed NO text never really spoke;
      // one WITH text counts (the loop persisted the partial, stamped).
      if (errored || failedCause) return SKIPPED;
      if (abort.signal.aborted && !replyText.trim()) return SKIPPED;
      return { spoke: true, text: stripLeadingSelfPrefix(replyText, agent.name).trim(), yielded: didYield };
    },
  );

  if (!locked.ok) {
    // Held by a 1:1 chat or another channel turn — both outrank/equal us.
    sendSystem(ws, channelId, `${agent.name} is in another conversation right now — skipping their turn.`);
    return SKIPPED;
  }
  return locked.value;
}

// Monotonic PER-CHANNEL turnSeq source. Date.now() alone can repeat across two
// fast back-to-back sub-turns (same millisecond); this guarantees each speaker
// in a queue gets a strictly greater, distinct value the UI can key bubbles on.
// Namespaced by channel so concurrent volleys in different channels can't
// interleave each other's sequence, and seeding from the clock keeps values
// monotonic across a server restart too.
const lastTurnSeqByChannel = new Map<string, number>();
function nextTurnSeq(channelId: string): number {
  const now = Date.now();
  const prev = lastTurnSeqByChannel.get(channelId) ?? 0;
  const seq = now > prev ? now : prev + 1;
  lastTurnSeqByChannel.set(channelId, seq);
  return seq;
}
