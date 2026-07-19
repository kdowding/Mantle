import type { Provider, ProviderErrorKind, ProviderMessage, ToolDefinition, TokenUsage, StopReason, MessageContent, ThinkingLevel, SystemPromptInput } from "./providers/types.js";
import type { SessionManager, SessionMessage } from "./session.js";
import type { AgentAttachmentMeta, ToolProgressEvent } from "../tools/types.js";
import { truncateToolResult } from "./truncation.js";
import { createSemaphoreMap, classifyTool, toolTimeoutMs, type ToolCategory } from "./concurrency.js";
import { LoopDetector } from "./loop-detector.js";
import { TurnReadCache, WRITE_TOOLS } from "./turn-cache.js";
import { repairToolArgs } from "../tools/core/tool-arg-repair.js";
import { toolLabel } from "./tool-labels.js";
import { openTurnMailbox } from "./turn-mailbox.js";
import type { ToolStatus } from "../tools/types.js";

// Coerce a wire/client thinking level to the API's ThinkingLevel union. All six
// levels pass through; the per-provider reasoning mappers (claude.ts /
// openai* / grok) clamp each one down to what the chosen model actually accepts,
// so an xhigh/max requested for a model that lacks it never reaches the wire as
// an invalid value. Typed replacement for the `thinkingLevel as any` casts at
// the chat + cron dispatch sites.
export function coerceThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  switch (value) {
    case "off":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    default:
      return undefined;
  }
}

// Convert tool-produced attachment metadata into the content blocks the
// renderer understands. Shared by the normal next-assistant-message drain,
// the interrupted-turn partial persist, and the graceful landing — so an
// attachment produced right before an abort/limit isn't lost on reload.
function toAttachmentBlocks(attachments: AgentAttachmentMeta[]): MessageContent[] {
  return attachments.map((att) =>
    att.category === "image"
      ? {
          type: "image",
          fileId: att.fileId,
          mediaType: att.mediaType,
          filename: att.filename,
          size: att.size,
        }
      : {
          type: "file",
          fileId: att.fileId,
          mediaType: att.mediaType,
          filename: att.filename,
          size: att.size,
          extractedText: att.extractedText,
        },
  );
}

// Events emitted to the caller (UI/WebSocket)
export type AgentStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_end" }
  | { type: "tool_call_start"; name: string; id: string }
  | { type: "tool_call_input"; id: string; input: Record<string, unknown> }
  // Fired the instant we hand the call to executeToolCall — the gap
  // between this and tool_call_result is real wall-clock execution
  // time. The UI uses startedAt to replace the static spinner with a
  // live "Ns" counter so a slow tool reads as "still working" rather
  // than "stuck." Distinct from tool_call_input (which fires on JSON
  // arg parse, before dispatch).
  // `label` is a short human summary of what the tool is doing ("read
  // MEMORY.md", "recall: \"flaky tests\"") shown next to the Ns counter so
  // englyph/MCP/web tools that emit no progress still read as "working."
  | { type: "tool_call_executing"; id: string; startedAt: number; label?: string }
  // A chunk of live output from a still-running tool. Tools that opt in
  // (currently bash) call ToolContext.progress for each stdout/stderr
  // chunk; the loop tags it with the tool_use id and forwards. The UI
  // appends to a per-tool live output pane so users see bash output
  // land in real time instead of waiting for the entire command.
  | { type: "tool_call_progress"; id: string; chunk: string; stream?: "stdout" | "stderr" }
  // `tag` is the classifier's short reason chip ("exit 1", "written",
  // "empty", "not found") rendered beside the done/error status.
  | { type: "tool_call_result"; id: string; result: string; isError: boolean; tag?: string }
  // Fired the moment an attach_local_file / attach_url_file tool
  // succeeds — the UI inserts the file into the active assistant
  // bubble immediately, in advance of the assistant's continuation
  // text. Persistence happens separately on the next assistant
  // message so the attachment survives reload.
  | { type: "agent_attachment"; attachment: AgentAttachmentMeta; toolUseId: string }
  | { type: "message_end"; usage?: TokenUsage }
  | { type: "blank_response"; canRetry: boolean }
  // A steer-while-busy note was folded into the running turn (count = how
  // many queued notes landed in this drain). Lets the UI confirm delivery
  // and render the note bubble inline at its true position.
  | { type: "note_delivered"; count: number; text: string }
  | { type: "error"; error: string };

// Tool execution returns enough for the loop to:
//   - hand `result` back to the model in the synthetic tool_result block
//   - prepend `attachments` to the NEXT assistant message so they
//     persist in the JSONL transcript and re-render on reload
export interface ToolCallOutcome {
  result: string;
  // Semantic status + short reason tag stamped by the registry classifier
  // and carried (instead of thrown away) through the dispatch closures, so
  // the loop-detector's failing-tool signal and the UI chip see structure.
  status?: ToolStatus;
  tag?: string;
  // Whether the tool RAN but errored. The closures now RETURN this rather
  // than throwing, so the loop honors it directly.
  isError?: boolean;
  attachments?: AgentAttachmentMeta[];
  // A pinned pseudo-tool (e.g. cron_report) can declare its call terminal:
  // once its tool_result is persisted, the loop finishes the turn instead of
  // soliciting another step the model has nothing to fill. That empty
  // follow-up is exactly what surfaced as a spurious blank_response after the
  // agent had already reported and considered itself done.
  endTurn?: boolean;
}

// Per-call options the loop hands to the executeToolCall lambda. The
// caller wires these into the ToolContext it builds for the registry,
// which is how `signal` / `progress` reach the actual tool. `toolCallId`
// is stamped on every progress event the tool emits so the UI can route
// chunks back to the right bubble when multiple tools run in parallel.
export interface ToolCallOptions {
  signal?: AbortSignal;
  progress?: (event: ToolProgressEvent) => void;
  toolCallId: string;
}

export interface AgentLoopParams {
  provider: Provider;
  session: SessionManager;
  systemPrompt: SystemPromptInput;
  tools: ToolDefinition[];
  executeToolCall: (
    name: string,
    input: Record<string, unknown>,
    opts: ToolCallOptions,
  ) => Promise<ToolCallOutcome>;
  onEvent?: (event: AgentStreamEvent) => void;
  signal?: AbortSignal;
  maxIterations?: number;
  model: string;
  thinkingLevel?: ThinkingLevel;
  fastMode?: boolean;
  transformMessages?: (messages: ProviderMessage[]) => Promise<ProviderMessage[]>;
  // Optional per-category concurrency override for this loop invocation.
  // Default = DEFAULT_CONCURRENCY in concurrency.ts (bash:4, filesystem:8,
  // web:4, mcp:2, subagent:4, default:6). Heartbeat / sub-agent loops can
  // pass tighter caps when called from a constrained context.
  concurrencyOverrides?: Partial<Record<ToolCategory, number>>;
  // Hard wall-clock ceiling for the WHOLE turn (all iterations combined),
  // composed into the provider stream + every tool call. The 90s idle
  // watchdog only catches a stalled stream; this catches the pathological
  // "model emits one token every 89s for an hour" and "a chain of slow-but-
  // not-stalled tools" cases. On expiry the loop tries a graceful tools-off
  // summary instead of abandoning the work. Default DEFAULT_MAX_TURN_MS.
  maxTurnMs?: number;
  // Per-category override for the single-call tool timeout (ms; 0 = none).
  // Mirrors concurrencyOverrides — a constrained context (heartbeat/cron)
  // can tighten it, and it makes the watchdog deterministically testable.
  // Unset categories fall back to CATEGORY_TIMEOUTS in concurrency.ts.
  toolTimeoutOverrides?: Partial<Record<ToolCategory, number>>;
}

// ── TurnOutcome — the loop's structured return value ────────────────────────
//
// Why the loop returns a value: every caller used to scrape outcomes out of
// side effects (the sub-agent re-read the transcript for its result text, the
// outbox inferred success from exceptions, cron logged "ok" even when the
// provider died mid-turn because stream errors are emitted as events and
// never thrown). The outcome is the loop's own account of how the turn ended
// — callers branch on it instead of guessing.

export type TurnStopCause =
  | "completed"       // model ended its turn naturally (end_turn / max_tokens / no tool calls)
  | "aborted"         // external signal — /stop, preemption, shutdown
  | "idle_timeout"    // provider stream stalled (no events for STREAM_IDLE_TIMEOUT_MS)
  | "turn_timeout"    // whole-turn wall-clock deadline hit (see `landed`)
  | "max_iterations"  // iteration cap hit (see `landed`)
  | "loop_detected"   // loop-detector hard abort (stuck repeating)
  | "blank_response"  // model returned nothing twice in a row
  | "provider_error"; // stream threw / provider emitted an error event

export interface TurnOutcome {
  stopCause: TurnStopCause;
  // Iterations actually entered (1-based; a blank-retry re-roll doesn't count).
  iterations: number;
  // Summed across all iterations. inputTokens is the total context processed
  // (each iteration re-reads the conversation) — the billing-shaped number,
  // not the final context size.
  usage: TokenUsage;
  // The final assistant text persisted this turn — the landing summary, the
  // last full reply, or the interruption partial. "" when nothing landed.
  lastAssistantText: string;
  // Loop-detector reasons that fired this turn (warns + the abort), in order.
  detections: string[];
  // Steer-while-busy notes folded into this turn via the turn mailbox.
  notesDelivered: number;
  // For turn_timeout / max_iterations: whether the graceful tools-off landing
  // produced (and persisted) a summary. False = the bare limit error surfaced.
  landed?: boolean;
  // For provider_error: the message that was emitted to the UI.
  error?: string;
  // For provider_error: the provider's coarse classification when it sent
  // one — lets consumers (delivery outbox, cron backoff) branch on shape
  // instead of regexing the message.
  errorKind?: ProviderErrorKind;
}

// Raised from 25 → 100 (2026-05). The loop detector (loop-detector.ts)
// now catches "stuck repeating same call" within 3-5 iterations, so the
// hard cap can be much more generous before catastrophic-runaway
// becomes the bottleneck instead of stuck-loop. Complex refactors and
// multi-file audits routinely need 30-60 iterations; the old 25 cap was
// genuinely cutting off legitimate work. Per-loop override available
// via AgentLoopParams.maxIterations.
const DEFAULT_MAX_ITERATIONS = 100;

// Per-step auto-retry budget for blank responses. Grok occasionally
// returns finish_reason="stop" with no content and no tool calls — a
// transient xAI quirk. We silently re-stream once before surfacing the
// failure to the UI. Resets to zero on any successful step.
const MAX_BLANK_RETRIES_PER_STEP = 1;

// Maximum gap between stream events before we declare the provider
// stalled and abort. 90s is generous enough to absorb extended-thinking
// startup latency on Claude (the SDK emits thinking_delta events as it
// thinks, so genuine reasoning shouldn't trigger this) and large-context
// first-token delays, but tight enough that a hung HTTP connection gets
// caught instead of silently burning a session slot.
const STREAM_IDLE_TIMEOUT_MS = 90_000;

// Hard ceiling on total wall-clock for one turn (all iterations). Generous
// — a deep multi-file refactor with slow builds can legitimately run many
// minutes — but bounded so an unattended heartbeat/cron turn can't run
// forever on a sequence of slow-but-never-idle steps. Override per-loop via
// AgentLoopParams.maxTurnMs.
const DEFAULT_MAX_TURN_MS = 10 * 60_000;

export async function runAgentLoop(params: AgentLoopParams): Promise<TurnOutcome> {
  const {
    provider,
    session,
    systemPrompt,
    tools,
    executeToolCall,
    onEvent,
    signal,
    model,
    thinkingLevel,
    fastMode,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    transformMessages,
    concurrencyOverrides,
    maxTurnMs = DEFAULT_MAX_TURN_MS,
    toolTimeoutOverrides,
  } = params;

  const emit = onEvent ?? (() => {});
  // TurnOutcome accumulators — see the type's doc block above.
  let iterationsRun = 0;
  const turnUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let lastAssistantText = "";
  const detections: string[] = [];
  let notesDelivered = 0;
  const finish = (
    stopCause: TurnStopCause,
    extra?: { landed?: boolean; error?: string; errorKind?: ProviderErrorKind },
  ): TurnOutcome => ({
    stopCause,
    iterations: iterationsRun,
    usage: turnUsage,
    lastAssistantText,
    detections,
    notesDelivered,
    ...extra,
  });

  // Steer-while-busy mailbox: the user can post notes to this session while
  // the turn runs (ws.ts routes them via postTurnNote). Drained at the top of
  // every iteration and folded into the transcript as a user-role message
  // (origin:"note" — retry/edit anchoring skips it), so the model sees the
  // note with its next inference and decides for itself whether to adjust
  // course, answer it, or finish the current step first.
  const mailbox = openTurnMailbox(session.sessionId);
  // `leftover` = notes recovered at close (posted during the final stream):
  // they're persisted for the NEXT turn, so they don't count as delivered to
  // this one and don't fire the delivery event — the ws-level note_queued ack
  // already confirmed receipt.
  const persistNotes = async (notes: string[], leftover = false): Promise<void> => {
    if (notes.length === 0) return;
    const text =
      `[Mid-turn note from the user — delivered while you were working:]\n\n` +
      `${notes.join("\n\n")}\n\n` +
      `[Take it into account. It's your call whether to adjust course now, answer it directly, or finish the current step first.]`;
    try {
      await session.appendMessage({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        role: "user",
        origin: "note",
        content: [{ type: "text", text }],
      });
      if (!leftover) {
        notesDelivered += notes.length;
        emit({ type: "note_delivered", count: notes.length, text });
      }
    } catch (err) {
      console.warn(
        `[MANTLE:loop] failed to persist mid-turn note: ${err instanceof Error ? err.message : err}`,
      );
    }
  };
  const addUsage = (u: TokenUsage | undefined): void => {
    if (!u) return;
    turnUsage.inputTokens += u.inputTokens ?? 0;
    turnUsage.outputTokens += u.outputTokens ?? 0;
    if (u.cacheReadTokens) turnUsage.cacheReadTokens = (turnUsage.cacheReadTokens ?? 0) + u.cacheReadTokens;
    if (u.cacheWriteTokens) turnUsage.cacheWriteTokens = (turnUsage.cacheWriteTokens ?? 0) + u.cacheWriteTokens;
  };
  let blankRetriesThisStep = 0;
  // Per-loop semaphores for parallel tool dispatch. One pool per
  // runAgentLoop invocation — sub-agents and heartbeat ticks running
  // concurrently each get their own caps, no cross-loop contention.
  // See concurrency.ts for category defaults and rationale.
  const semaphores = createSemaphoreMap(concurrencyOverrides);
  // Per-loop "is the model stuck repeating itself" detector. State is
  // a 30-call rolling window of (toolName, argsHash, resultHash);
  // resets fresh on every runAgentLoop invocation so a new user turn
  // starts with clean history. See loop-detector.ts for thresholds.
  const loopDetector = new LoopDetector();
  // Per-turn idempotent-read cache. Re-reading the same file/glob/grep
  // within a turn returns a short stub pointing at the original iter's
  // tool_result block (still in the model's context) instead of
  // re-shipping the full content. Write tools invalidate overlapping
  // entries so post-edit reads return fresh content. See turn-cache.ts
  // for the cacheable allowlist and invalidation rules.
  const readCache = new TurnReadCache();
  // Tripped when loop-detector hits the abort threshold. Persist this
  // iteration's tool_results (with the warning appended) first, then
  // exit cleanly after the user message write so the transcript stays
  // self-consistent for /retry.
  let loopAborted = false;
  let loopAbortReason = "";
  // Attachments produced by tools in the previous iteration. Prepended
  // as content blocks to the NEXT assistant message so the UI's
  // existing renderer (image / file blocks) picks them up on reload
  // and the file is bound to the same bubble as the model's "here
  // you go" continuation text.
  let pendingAttachments: AgentAttachmentMeta[] = [];

  // Whole-turn deadline. Composed into every provider stream AND every tool
  // call below, so neither a slow-drip stream nor a chain of slow tools can
  // outlast it. `turnTimedOut` distinguishes this from /stop and the idle
  // watchdog so we can land gracefully instead of erroring.
  let turnTimedOut = false;
  const turnDeadline = new AbortController();
  const turnDeadlineTimer = setTimeout(() => {
    turnTimedOut = true;
    turnDeadline.abort();
  }, maxTurnMs);

  // Graceful landing: when the turn is cut short (max iterations or the turn
  // deadline), make one final tools-OFF pass asking the model to summarize
  // what it did and what's left, instead of emitting a bare error and
  // abandoning all accumulated work. Returns true if it produced (and
  // persisted) a usable summary. Defensive — any failure returns false so
  // the caller still surfaces the original limit error.
  const emitGracefulLanding = async (notice: string): Promise<boolean> => {
    try {
      // Same projection the main iterations use — transformMessages may be
      // load-bearing, not cosmetic (the channel POV transform reshapes a
      // multi-author transcript into one the provider accepts; the chat
      // attachment resolver inlines upload bytes). Skipping it here would
      // send a transcript the provider has never seen and may reject.
      let base = await session.getTranscriptForProvider();
      if (transformMessages) base = await transformMessages(base);
      const landingMessages: ProviderMessage[] = [
        ...base,
        { role: "user", content: [{ type: "text", text: notice }] },
      ];
      // An IDLE watchdog (reset per event), not a total cap — a long but
      // healthy summary shouldn't be cut at 90s of wall clock. Composed with
      // the user's /stop so the landing isn't un-stoppable; if either fires
      // mid-stream we persist whatever already streamed (marked) rather than
      // discarding it.
      const ac = new AbortController();
      const landingSignal = AbortSignal.any([ac.signal, ...(signal ? [signal] : [])]);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const resetTimer = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => ac.abort(), STREAM_IDLE_TIMEOUT_MS);
      };
      const parts: string[] = [];
      let interrupted = false;
      resetTimer();
      try {
        const landingStream = provider.stream({
          messages: landingMessages,
          systemPrompt,
          tools: [],
          model,
          signal: landingSignal,
          fastMode,
        });
        for await (const ev of landingStream) {
          resetTimer();
          if (ev.type === "text_delta") {
            parts.push(ev.text);
            emit({ type: "text_delta", text: ev.text });
          }
        }
      } catch (err) {
        if (!landingSignal.aborted) throw err;
        interrupted = true; // /stop or idle cut — keep what streamed
      } finally {
        if (timer) clearTimeout(timer);
      }
      const text = parts.join("").trim();
      if (!text) return false;
      // Attachments produced by tools in the final iteration would normally
      // ride to the next assistant message — there isn't one, so they land
      // on the landing summary instead of vanishing on reload.
      const content: MessageContent[] = toAttachmentBlocks(pendingAttachments);
      pendingAttachments = [];
      content.push({ type: "text", text });
      if (interrupted) content.push({ type: "text", text: "\n[summary interrupted]" });
      await session.appendMessage({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        role: "assistant",
        content,
        model,
        provider: provider.name,
      });
      lastAssistantText = text;
      emit({ type: "message_end" });
      return true;
    } catch (err) {
      console.warn(
        `[MANTLE:loop] graceful landing failed: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  };

  const turnLimitSeconds = Math.round(maxTurnMs / 1000);
  // Land the turn on a deadline hit: graceful summary if possible, else a
  // plain limit error. Used from both the iteration-top check and the
  // stream catch (the deadline can fire during streaming or during tools).
  // Returns whether the landing produced a summary (TurnOutcome.landed).
  const landTurnLimit = async (): Promise<boolean> => {
    const landed = await emitGracefulLanding(
      `[System notice: this turn has reached its ${turnLimitSeconds}s time limit. Stop here. In a few sentences, tell the user what you accomplished and exactly what remains so they can continue.]`,
    );
    if (!landed) {
      emit({ type: "error", error: `Turn exceeded its ${turnLimitSeconds}s time limit.` });
    }
    return landed;
  };

  try {
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal?.aborted) {
      emit({ type: "error", error: "Aborted" });
      return finish("aborted");
    }
    // Turn deadline fired between iterations (e.g. during tool execution) —
    // land gracefully rather than starting another iteration.
    if (turnTimedOut) {
      return finish("turn_timeout", { landed: await landTurnLimit() });
    }
    iterationsRun++;

    // Fold in any steer-while-busy notes posted since the last iteration —
    // BEFORE the transcript read, so the model sees them this inference.
    await persistNotes(mailbox.drain());

    // Load current transcript
    let messages = await session.getTranscriptForProvider();

    // Resolve attachments for the target provider (if hook provided).
    // The transform may do disk I/O (resolveAttachmentsForProvider reads
    // upload files), so a /stop during this step previously had to wait
    // for the whole transform to finish before the next iteration's
    // top-of-loop abort check fired. Re-check signal afterward so the
    // exit is immediate.
    if (transformMessages) {
      messages = await transformMessages(messages);
      if (signal?.aborted) {
        emit({ type: "error", error: "Aborted" });
        return finish("aborted");
      }
    }

    // Idle watchdog: aborts the provider stream if no event arrives
    // within STREAM_IDLE_TIMEOUT_MS. Composed with the user-provided
    // signal via AbortSignal.any so /stop and idle-timeout both flow
    // through the same abort plumbing on the provider/SDK side
    // (fetch().abort triggers, request unwinds, our catch fires).
    const idleAbort = new AbortController();
    let idleTimedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        idleAbort.abort();
      }, STREAM_IDLE_TIMEOUT_MS);
    };
    const composedSignal: AbortSignal = AbortSignal.any([
      ...(signal ? [signal] : []),
      idleAbort.signal,
      turnDeadline.signal,
    ]);

    // Stream from provider
    const stream = provider.stream({
      messages,
      systemPrompt,
      tools,
      model,
      signal: composedSignal,
      thinkingLevel,
      fastMode,
    });

    // Accumulate the assistant's response
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls = new Map<string, { name: string; argsJson: string; input?: Record<string, unknown> }>();
    let stopReason: StopReason = "end_turn";
    let usage: TokenUsage | undefined;

    // A /stop, idle-timeout, or provider error mid-stream used to discard
    // this iteration's streamed text entirely — the on-screen reply diverged
    // from the transcript on reload, and /retry replayed from scratch.
    // Persist what visibly streamed (text + pending attachments; never
    // tool_use, which would be an orphan block) with an explicit marker.
    // Best-effort: a persist failure must never mask the original error.
    const persistPartial = async (reason: string): Promise<void> => {
      const text = textParts.join("").trim();
      // No text AND no pending attachments → nothing the user saw; don't
      // persist thinking-only fragments. (Attachments alone DO persist —
      // a file attached right before an abort must survive reload, per the
      // design note on toAttachmentBlocks.)
      if (!text && pendingAttachments.length === 0) return;
      try {
        const content: MessageContent[] = toAttachmentBlocks(pendingAttachments);
        pendingAttachments = [];
        const thinking = thinkingParts.join("").trim();
        if (thinking) content.push({ type: "thinking", text: thinking });
        if (text) content.push({ type: "text", text });
        content.push({ type: "text", text: `\n[${reason} — reply cut off here]` });
        await session.appendMessage({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          role: "assistant",
          content,
          model,
          provider: provider.name,
        });
        if (text) lastAssistantText = text;
      } catch (err) {
        console.warn(
          `[MANTLE:loop] failed to persist partial reply: ${err instanceof Error ? err.message : err}`,
        );
      }
    };

    resetIdleTimer();
    try {
      for await (const event of stream) {
        resetIdleTimer();
        if (signal?.aborted) {
          await persistPartial("Interrupted");
          emit({ type: "error", error: "Aborted" });
          return finish("aborted");
        }

        switch (event.type) {
          case "thinking_delta":
            thinkingParts.push(event.text);
            emit({ type: "thinking_delta", text: event.text });
            break;

          case "thinking_end":
            emit({ type: "thinking_end" });
            break;

          case "text_delta":
            textParts.push(event.text);
            emit({ type: "text_delta", text: event.text });
            break;

          case "tool_call_start":
            toolCalls.set(event.id, { name: event.name, argsJson: "" });
            emit({ type: "tool_call_start", name: event.name, id: event.id });
            break;

          case "tool_call_delta": {
            const tc = toolCalls.get(event.id);
            if (tc) tc.argsJson += event.args;
            break;
          }

          case "tool_call_end":
            // Parse and emit the completed tool call input
            try {
              const tc = toolCalls.get(event.id);
              if (tc) {
                const parsed = tc.argsJson ? JSON.parse(tc.argsJson) : {};
                emit({ type: "tool_call_input", id: event.id, input: parsed });
              }
            } catch {
              // JSON parse failed — will handle during execution
            }
            break;

          case "message_end":
            stopReason = event.stopReason;
            usage = event.usage;
            addUsage(event.usage);
            break;

          case "error":
            emit({ type: "error", error: event.error });
            await persistPartial("Provider error");
            return finish("provider_error", { error: event.error, errorKind: event.kind });
        }
      }
    } catch (err) {
      // Distinguish the failure modes:
      //   0. Turn deadline fired — land gracefully (summary) instead of a
      //      raw error; checked first because the turn signal also trips the
      //      composed stream signal, so idle/abort would otherwise mask it.
      //   1. Idle watchdog fired — surface a specific message so the user
      //      knows it wasn't /stop or a model error and can /retry.
      //   2. User aborted — same shape the iteration-top check would emit.
      //   3. Anything else — pass through.
      if (turnTimedOut) {
        // Keep this iteration's streamed text in the transcript before the
        // landing pass — the landing rebuilds from the persisted transcript,
        // so without this the cut iteration's words vanish from its summary.
        await persistPartial("Turn time limit reached");
        return finish("turn_timeout", { landed: await landTurnLimit() });
      }
      if (idleTimedOut) {
        const seconds = Math.round(STREAM_IDLE_TIMEOUT_MS / 1000);
        console.warn(`[MANTLE:loop] Provider stream stalled after ${seconds}s of inactivity`);
        await persistPartial("Provider stream stalled");
        emit({
          type: "error",
          error: `Provider stream stalled — no activity for ${seconds}s. The model may be overloaded; try /retry.`,
        });
        return finish("idle_timeout");
      }
      if (signal?.aborted) {
        await persistPartial("Interrupted");
        emit({ type: "error", error: "Aborted" });
        return finish("aborted");
      }
      const message = err instanceof Error ? err.message : String(err);
      await persistPartial("Provider error");
      emit({ type: "error", error: message });
      return finish("provider_error", { error: message });
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }

    // Resolve each tool call's arguments ONCE, here, so the persisted
    // assistant message and the execution path below agree on the input.
    // On a JSON parse failure, try a conservative repair (Grok/local models
    // routinely wrap the object in a ```fence, leading prose, smart quotes,
    // HTML entities, or a trailing comma); if repair fails too, tag
    // `_parseError` so registry.execute surfaces the real "your JSON was
    // malformed" message ON THIS TURN. Previously the execution path
    // silently re-parsed and ran the tool with `{}`, so the model got a
    // misleading "missing required parameter" and only saw the real cause
    // after a /retry — the recovery branch was effectively dead live.
    for (const tc of toolCalls.values()) {
      if (!tc.argsJson) {
        tc.input = {};
        continue;
      }
      try {
        tc.input = JSON.parse(tc.argsJson) as Record<string, unknown>;
      } catch {
        const repaired = repairToolArgs(tc.argsJson);
        if (repaired) {
          tc.input = repaired.input;
          if (repaired.repaired) {
            console.warn(`[MANTLE:loop] repaired malformed tool args for \`${tc.name}\``);
          }
        } else {
          tc.input = { _raw: tc.argsJson, _parseError: true };
        }
      }
    }

    // Build the assistant message content blocks
    const assistantContent: MessageContent[] = [];

    // Persist thinking content (if any)
    const fullThinking = thinkingParts.join("");
    if (fullThinking) {
      assistantContent.push({ type: "thinking", text: fullThinking });
    }

    const fullText = textParts.join("");
    if (fullText) {
      assistantContent.push({ type: "text", text: fullText });
    }

    // Add tool_use blocks (args resolved + repaired once, above).
    for (const [id, tc] of toolCalls) {
      assistantContent.push({ type: "tool_use", id, name: tc.name, input: tc.input ?? {} });
    }

    // Blank-response handling. Grok (and occasionally Claude) can finish
    // a turn with no text, no thinking, and no tool calls — usually a
    // transient provider hiccup, sometimes a moderation bail-out. The
    // empty turn is useless to the user AND poisons the next request on
    // strict OpenAI-compat backends. So:
    //   1. Don't persist it to the transcript.
    //   2. Auto-retry once silently (most cases recover).
    //   3. If retry also blanks, surface a `blank_response` event so the
    //      UI can show a manual retry affordance, and exit cleanly.
    // Pending attachments count as content — if the model called an
    // attach tool last iteration and is otherwise silent now, the
    // attachments still need a home.
    const isBlank =
      fullText.length === 0 &&
      fullThinking.length === 0 &&
      toolCalls.size === 0 &&
      pendingAttachments.length === 0;

    if (isBlank) {
      if (blankRetriesThisStep < MAX_BLANK_RETRIES_PER_STEP) {
        blankRetriesThisStep++;
        console.warn(
          `[MANTLE:loop] Blank response from ${provider.name}/${model} (stop=${stopReason}); auto-retrying ${blankRetriesThisStep}/${MAX_BLANK_RETRIES_PER_STEP}`,
        );
        iteration--; // don't burn an iteration on a no-op turn
        iterationsRun--; // a re-roll isn't an iteration the outcome counts
        continue;
      }
      // Auto-retry exhausted — surface to the UI without persisting.
      console.warn(
        `[MANTLE:loop] Blank response persisted after ${MAX_BLANK_RETRIES_PER_STEP} retries on ${provider.name}/${model}; surfacing to UI`,
      );
      emit({ type: "blank_response", canRetry: true });
      return finish("blank_response");
    }

    // Reset the per-step retry budget after any non-blank turn so a
    // later step in the same loop gets its own auto-retry quota.
    blankRetriesThisStep = 0;

    // Drain pending attachments into this assistant message. They go
    // FIRST in the content array so the UI's renderer puts them
    // visually above the model's continuation text — matches the
    // mental model of "here's the file, and here's what I'm saying
    // about it."
    if (pendingAttachments.length > 0) {
      assistantContent.unshift(...toAttachmentBlocks(pendingAttachments));
      pendingAttachments = [];
    }

    // A terminal stopReason arriving WITH tool calls orphans them: the loop
    // returns right after persisting (see the completion check below), the
    // emitted tool_use blocks never execute, the UI replays phantom calls on
    // reload, and the next provider request would carry orphan blocks.
    //   - max_tokens: the response was cut off mid-tool-call.
    //   - end_turn:   OpenAI-compat quirk — finish_reason "stop" alongside
    //     tool_calls (seen on strict llama.cpp templates); args may be
    //     half-formed, so executing them is riskier than telling the model
    //     to re-issue.
    // Drop them, close the UI's spinners, and say what happened in-band.
    if ((stopReason === "max_tokens" || stopReason === "end_turn") && toolCalls.size > 0) {
      const reason =
        stopReason === "max_tokens"
          ? "the response hit its max-token limit first"
          : "the model ended its turn without awaiting them";
      for (const id of toolCalls.keys()) {
        emit({
          type: "tool_call_result",
          id,
          result: `[not executed — ${reason}]`,
          isError: true,
        });
      }
      toolCalls.clear();
      for (let i = assistantContent.length - 1; i >= 0; i--) {
        if (assistantContent[i].type === "tool_use") assistantContent.splice(i, 1);
      }
      assistantContent.push({
        type: "text",
        text:
          stopReason === "max_tokens"
            ? "\n[Response hit the max-token limit before its tool calls could run — they were not executed.]"
            : "\n[The turn ended before its tool calls could run — they were not executed. Re-issue them if still needed.]",
      });
    }

    // Persist assistant message
    const assistantMsg: SessionMessage = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      role: "assistant",
      content: assistantContent,
      model,
      provider: provider.name,
      usage,
      stopReason,
    };
    await session.appendMessage(assistantMsg);
    if (fullText) lastAssistantText = fullText;

    // If no tool calls, we're done
    if (stopReason === "end_turn" || stopReason === "max_tokens" || toolCalls.size === 0) {
      emit({ type: "message_end", usage });
      return finish("completed");
    }

    // Execute tool calls IN PARALLEL. Models routinely emit multiple
    // independent tool_use blocks per turn (e.g. three file reads); the
    // old sequential loop made wall-clock = sum, this gives us
    // wall-clock = max. Anthropic requires tool_result blocks in the
    // same order as the tool_use blocks that triggered them, so we keep
    // the original order list and assemble results into it after all
    // promises settle. tool_call_result events fire as each individual
    // tool finishes (out of completion order is fine — UI matches by
    // id) so fast tools visibly complete while slow ones still spin.
    const toolResultContent: MessageContent[] = [];
    const orderedIds = Array.from(toolCalls.keys());
    const settled = new Map<
      string,
      { result: string; isError: boolean; status?: ToolStatus; tag?: string; attachments?: AgentAttachmentMeta[]; endTurn?: boolean }
    >();

    await Promise.all(
      orderedIds.map(async (id) => {
        const tc = toolCalls.get(id)!;
        // Args were resolved + repaired once above; reuse that so a repaired
        // call actually RUNS with the repaired args and a _parseError call
        // hits registry.execute's malformed-JSON branch.
        const input = tc.input ?? {};

        // Human-readable label for the executing event (undefined for an
        // unrepairable _parseError call → UI shows a bare spinner). Computed
        // once; reused by both the cache-hit and real-exec emit sites.
        const label = toolLabel(tc.name, input);

        const progress = (ev: ToolProgressEvent) => {
          emit({ type: "tool_call_progress", id, chunk: ev.chunk, stream: ev.stream });
        };

        let result: string;
        let isError = false;
        let status: ToolStatus | undefined;
        let tag: string | undefined;
        let attachments: AgentAttachmentMeta[] | undefined;
        let endTurn = false;

        // Cache check: same cacheable tool + identical args within
        // this turn → serve a stub pointing at the prior iter's
        // tool_result block (which is still in the model's context).
        // Saves redundant transcript bloat on multi-iter turns. Write
        // tools (write_file, edit_file) invalidate overlapping entries
        // when they fire below, so post-edit reads run fresh.
        const cacheEntry = readCache.lookup(tc.name, input);

        if (cacheEntry) {
          // Fire the executing event for UI continuity (the UI still
          // shows the tool starting), then synthesize the stub. No
          // semaphore acquire — there's no real work to gate. No
          // truncation either — the stub is already short.
          emit({ type: "tool_call_executing", id, startedAt: Date.now(), label });
          result = readCache.buildStubResult(tc.name, input, cacheEntry);
          // Cached read = a prior successful result; leave status/tag undefined (ok).
        } else {
          // Acquire a slot in the per-category semaphore BEFORE emitting
          // the executing event — queue time is silent, so the UI's "Ns"
          // counter measures real execution time, not "20 bash calls all
          // claiming to start simultaneously while only 4 actually run."
          // Slot is released in finally so an error path still frees it.
          const releaseSlot = await semaphores.acquire(classifyTool(tc.name));

          // Mark the moment execution actually starts so the UI can
          // start ticking a "Ns" counter. Sequenced after the slot
          // acquire so a queued tool doesn't look "stuck" — its
          // executing event fires only when it really begins.
          emit({ type: "tool_call_executing", id, startedAt: Date.now(), label });

          // Per-call hard timeout + composed cancellation. The tool gets a
          // signal composed from /stop + the turn deadline + a per-call
          // timeout so well-behaved tools cancel promptly. But the idle
          // watchdog never covered tool execution at all, so a signal-DEAF
          // tool (a wedged MCP server, a stalled fetch that ignores abort)
          // could freeze the whole turn forever. We therefore RACE the tool
          // against the timeout: on expiry we abandon the await, return an
          // error result the loop-detector and model can route around, and
          // let the orphaned promise settle silently in the background.
          const toolCategory = classifyTool(tc.name);
          const timeoutMs = toolTimeoutOverrides?.[toolCategory] ?? toolTimeoutMs(tc.name);
          const perCallAbort = new AbortController();
          const toolSignal = AbortSignal.any([
            perCallAbort.signal,
            ...(signal ? [signal] : []),
            turnDeadline.signal,
          ]);
          let toolTimer: ReturnType<typeof setTimeout> | null = null;
          // True when the timeout path handed the semaphore slot to the
          // orphaned tool — the outer finally must then NOT release it too.
          let slotHeldByOrphan = false;
          try {
            const execPromise = executeToolCall(tc.name, input, {
              signal: toolSignal,
              progress,
              toolCallId: id,
            });
            if (timeoutMs > 0) {
              const TIMEOUT = Symbol("tool-timeout");
              const timeoutPromise = new Promise<typeof TIMEOUT>((res) => {
                toolTimer = setTimeout(() => res(TIMEOUT), timeoutMs);
              });
              const winner = await Promise.race([execPromise, timeoutPromise]);
              if (winner === TIMEOUT) {
                perCallAbort.abort(); // best-effort cancel for signal-aware tools
                // The orphaned tool is STILL RUNNING — it keeps its semaphore
                // slot until it actually settles, otherwise N wedged + N fresh
                // calls means 2N concurrent and the category caps are fiction.
                // (Also swallows the eventual settle/rejection.)
                slotHeldByOrphan = true;
                void execPromise.then(
                  () => releaseSlot(),
                  () => releaseSlot(),
                );
                result =
                  `[Tool \`${tc.name}\` exceeded its ${Math.round(timeoutMs / 1000)}s time limit and was abandoned. ` +
                  `It may still be finishing in the background. Try a narrower call (smaller scope or more specific arguments) or a different approach.]`;
                // Synthetic result — never passed through the classifier, so
                // set status/tag inline (a timeout is a failure).
                isError = true;
                status = "failed";
                tag = "timeout";
              } else {
                result = winner.result;
                attachments = winner.attachments;
                status = winner.status;
                tag = winner.tag;
                if (winner.isError) isError = true;
                if (winner.endTurn) endTurn = true;
              }
            } else {
              const outcome = await execPromise;
              result = outcome.result;
              attachments = outcome.attachments;
              status = outcome.status;
              tag = outcome.tag;
              if (outcome.isError) isError = true;
              if (outcome.endTurn) endTurn = true;
            }
          } catch (err) {
            // A real thrown crash (provider/transform error, or a closure that
            // still throws) — rare now that closures return isError.
            result = err instanceof Error ? err.message : String(err);
            isError = true;
            status = "failed";
          } finally {
            // Release the semaphore slot regardless of how the tool
            // exited — error, success, or thrown crash. The timeout path is
            // the exception: the orphaned tool still holds the slot and
            // releases it itself when it eventually settles (above).
            if (toolTimer) clearTimeout(toolTimer);
            if (!slotHeldByOrphan) releaseSlot();
          }

          // Cap any single tool result before it lands in the transcript or
          // the model's next-iteration context. Bash already self-truncates
          // at 100KB but MCP tools (englyph bulk searches) and big file
          // reads can dump unbounded output — without this a single chatty
          // call can crowd the context across iterations. Head + tail
          // strategy preserves both setup info and trailing errors/exit
          // codes. The UI sees the truncated form too, so the user
          // observes the same omission marker the model does.
          result = truncateToolResult(result);

          // Populate the cache for cacheable, non-error results so
          // subsequent identical calls this turn serve a stub instead
          // of re-running the tool. Writes invalidate overlapping
          // cached reads — the model can edit a file and immediately
          // re-read it fresh.
          if (!isError) {
            readCache.store(tc.name, input, result, iteration);
            if (WRITE_TOOLS.has(tc.name)) readCache.noteWrite(input);
            // bash can mutate anything (sed -i, git checkout, scripts) and
            // the path-overlap heuristic can't see inside the command — so a
            // successful bash call drops every cached read. Without this, a
            // bash edit followed by a re-read returned a confidently-stale
            // [CACHED RESULT] stub.
            if (classifyTool(tc.name) === "bash") readCache.clearAll();
          }
        }

        settled.set(id, { result, isError, status, tag, attachments, endTurn });

        // Emit per-tool completion as soon as this tool finishes.
        emit({ type: "tool_call_result", id, result, isError, tag });
        if (!isError && attachments && attachments.length > 0) {
          for (const att of attachments) {
            emit({ type: "agent_attachment", attachment: att, toolUseId: id });
          }
        }
      }),
    );

    // Loop-detection pass, in ORIGINAL tool_use order (not Promise.all
    // completion order — recording as tools happened to finish made the
    // detector's streak windows nondeterministic across identical turns).
    // Runs after truncation so the resultHash matches what the model will
    // actually see. Soft-warn feedback is appended to the PERSISTED result
    // (the model is the warning's audience); on abort, set the flag so we
    // exit cleanly after this iteration's tool_results are persisted
    // (so /retry has the full context).
    for (const id of orderedIds) {
      const tc = toolCalls.get(id)!;
      const r = settled.get(id)!;
      const detection = loopDetector.record(tc.name, tc.input ?? {}, r.result, iteration, r.status);
      if (detection) {
        r.result = `${r.result}\n\n${detection.message}`;
        detections.push(detection.reason);
        if (detection.severity === "abort") {
          loopAborted = true;
          loopAbortReason = detection.reason;
        }
      }
    }

    // Assemble tool_result blocks + pendingAttachments in ORIGINAL
    // tool_use order so the next provider request stays
    // Anthropic-conformant and attachments land on the next assistant
    // message in the order the model called the tools.
    for (const id of orderedIds) {
      const r = settled.get(id)!;
      toolResultContent.push({
        type: "tool_result",
        toolUseId: id,
        content: r.result,
        isError: r.isError,
      });
      if (!r.isError && r.attachments && r.attachments.length > 0) {
        pendingAttachments.push(...r.attachments);
      }
    }

    // Persist tool results as a user message (Anthropic convention)
    const toolResultMsg: SessionMessage = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      role: "user",
      content: toolResultContent,
    };
    await session.appendMessage(toolResultMsg);

    // Loop-detector tripped a hard abort during this iteration's tool
    // execution. The warning is already embedded in the affected tool's
    // result (appended above) and the tool_result message has been
    // persisted, so the transcript is self-consistent — /retry will see
    // the model's tool_use, the warning-tagged tool_result, and the
    // model's next iteration starts fresh from that context. Emit a
    // structured error so the UI can surface "stuck loop" distinctly.
    if (loopAborted) {
      emit({
        type: "error",
        error: `Loop detected (${loopAbortReason}) — turn stopped after ${iteration + 1} iteration${iteration === 0 ? "" : "s"}. See the tool result above for context.`,
      });
      return finish("loop_detected");
    }

    // A pinned pseudo-tool (cron_report) declared its call terminal. Its
    // tool_result is persisted above, so the tool_use/tool_result pair is
    // intact; finish cleanly here instead of looping for a follow-up turn the
    // model has nothing to fill — that empty turn is exactly what surfaced as
    // a bogus blank_response AFTER the agent had already reported and stopped.
    if (orderedIds.some((id) => settled.get(id)?.endTurn)) {
      emit({ type: "message_end", usage });
      return finish("completed");
    }

    // Continue the loop — the next iteration will include the tool results
  }

  // Hit max iterations — land gracefully (summarize progress + what's left)
  // instead of emitting a bare error and abandoning everything done so far.
  const landed = await emitGracefulLanding(
    `[System notice: you've reached the ${maxIterations}-iteration limit for this turn. Stop calling tools. In a few sentences, tell the user what you accomplished, what you found, and exactly what remains so they can continue.]`,
  );
  if (!landed) {
    emit({ type: "error", error: `Agent loop hit maximum iterations (${maxIterations})` });
  }
  return finish("max_iterations", { landed });
  } finally {
    clearTimeout(turnDeadlineTimer);
    // Notes posted after the final drain (during the last stream or the
    // landing) would otherwise vanish with the mailbox — persist them so
    // they greet the model at the start of the next turn instead.
    try {
      await persistNotes(mailbox.close(), /* leftover */ true);
    } catch (err) {
      console.warn(`[MANTLE:loop] mailbox close failed: ${err instanceof Error ? err.message : err}`);
    }
    // Block on any queued index.json writes from appendMessage so the
    // next consumer of the same agent's index (a chat starting after
    // a heartbeat tick, or vice versa) constructs its SessionManager
    // against fully-written state. Without this the asynchronous
    // index queue could leave a heartbeat's lastMessagePersona update
    // stranded across the lock release.
    try {
      await session.flushIndex();
    } catch (err) {
      console.warn(`[MANTLE:loop] index flush failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
