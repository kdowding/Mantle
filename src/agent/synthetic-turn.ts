// Shared "deliver a synthetic turn" flow.
//
// Both BackgroundTaskRunner.deliverResult and
// SubagentManager.deliverResult need the same thing: take a finished
// piece of async work, append a system-authored user message to a
// target session, then spin up a fresh agent loop so the agent
// responds to it naturally — all while holding the per-agent lock so
// the delivery doesn't trample (or get trampled by) a live chat turn.
//
// Composition: withAgentLock owns the wait/preempt/release idiom;
// runTriggeredAgentTurn owns the backend/prompt/tools/loop spin-up.
// What's left here is delivery-specific: the session existence check,
// the idempotent message append, the UI broadcasts, and the mapping
// from TurnOutcome to a DeliveryOutcome the outbox can act on.

import { resolve } from "path";
import { existsSync } from "fs";
import type { MantleConfig } from "../config/schema.js";
import type { LocalModelManager } from "../local/manager.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import { getAgent } from "../config/loader.js";
import { SessionManager, mutateSessionIndex } from "./session.js";
import { runTriggeredAgentTurn } from "./triggered-turn.js";
import { withAgentLock } from "./agent-lock.js";

// WS broadcast, INJECTED by the composition root (index.ts wires it to
// broadcastToAllWebSockets) so core never imports src/server — this
// replaces a lazy `await import("../server/ws.js")` that was the one
// wrong-direction value edge in the agent→server graph. Null until wired;
// tools-only / test contexts simply run silent.
let wsBroadcast: ((msg: Record<string, unknown>) => void) | null = null;

export function setSyntheticTurnBroadcast(fn: (msg: Record<string, unknown>) => void): void {
  wsBroadcast = fn;
}

export interface DeliverSyntheticTurnParams {
  config: MantleConfig;
  registry: ToolRegistry;
  localModelManager?: LocalModelManager;
  // Target session — the agent + session the synthetic message lands in
  // and the loop runs against.
  agentId: string;
  sessionId: string;
  // The fully-assembled user-role message (header + body + trailer).
  // The caller owns the wording; that's the main content difference
  // between background and sub-agent delivery. Stable across retries —
  // the idempotent-append scan keys on it.
  message: string;
  // Tagging for the broadcast events the UI routes on.
  source: "background" | "subagent" | "cron";
  toolName: string;
  taskId: string;
  status: string;
  // Prefix for this call's log lines, e.g. "[MANTLE:bg] bg-abc123".
  logTag: string;
  // Lets the owning manager short-circuit if it was disposed while we
  // were waiting for the lock.
  isDisposed: () => boolean;
  // Durable append-state from the caller (the outbox stamps `appended` on
  // its entry the moment the message lands). When true, the tail scan is
  // skipped entirely — it only looked at the last 30 rows, so a busy
  // session could scroll the marker out and a retry would re-append.
  alreadyAppended?: boolean;
  // Fired right after a fresh append succeeds so the caller can persist
  // its stamp.
  onAppended?: () => void;
  // Extra tool-context merged into every tool call. Sub-agents thread
  // { subagentManager, subagentDepth } so a delivered turn can still
  // spawn; background passes nothing (no recursion into more async work).
  extraToolContext?: Partial<ToolContext>;
  maxIterations?: number;
  // How long to poll for the per-agent lock before reporting "lock_timeout".
  // The durable outbox passes a short value (it retries on the next lock
  // release); a direct caller can use the default.
  lockWaitMs?: number;
  // Verbatim delivery: post `message` AS an assistant reply (the body was
  // already composed by the producing run — a cron digest), skipping the
  // re-inference turn. provider/model stamp the resulting assistant row.
  verbatim?: boolean;
  provider?: string;
  model?: string;
}

// Outcome of a single delivery attempt, so the caller (the durable outbox)
// can decide whether to retry, discard, or drop the entry:
//   delivered    — the synthetic turn ran (or was preempted AFTER the message
//                  landed); the message is in the session, do not re-deliver.
//   lock_timeout — couldn't get the agent lock in time; nothing was appended,
//                  safe to retry later.
//   disposed     — the producing manager was disposed mid-wait; retry later.
//   session_gone — the target agent/session no longer exists; discard.
//   error        — transient provider/runtime failure; the message append is
//                  idempotent, so the outbox can retry within bounds.
//   fatal_error  — provider failure that retrying can't fix (auth expired,
//                  request the provider rejects as malformed); the outbox
//                  discards instead of burning its full retry budget.
export type DeliveryOutcome = "delivered" | "lock_timeout" | "disposed" | "session_gone" | "error" | "fatal_error";

export async function deliverSyntheticTurn(params: DeliverSyntheticTurnParams): Promise<DeliveryOutcome> {
  const {
    config, registry, localModelManager,
    agentId, sessionId, message,
    source, toolName, taskId, status, logTag,
    isDisposed, extraToolContext, maxIterations = 10,
    lockWaitMs = 60_000,
    alreadyAppended = false, onAppended,
    verbatim = false, provider, model,
  } = params;

  if (isDisposed()) return "disposed";

  const agent = getAgent(config, agentId);
  if (!agent) {
    console.error(`${logTag} delivery aborted: unknown agent ${agentId}`);
    return "session_gone";
  }

  // Owner "background" so chat (and a channel turn) can preempt mid-delivery:
  // the preemption aborts the controller, which both stops the loop and tells
  // withAgentLock not to release a lock the preemptor now holds.
  const locked = await withAgentLock<DeliveryOutcome>(
    agentId,
    { owner: "background", policy: "wait", waitMs: lockWaitMs, shouldAbortWait: isDisposed },
    async (controller) => {
      try {
        // Preempted between acquire and append — nothing persisted yet, so
        // report retry-later instead of running a doomed turn.
        if (controller.signal.aborted) return "lock_timeout";

        const sessionsDir = resolve(config.basePath, ".mantle", "sessions", agentId);
        const sessionFile = resolve(sessionsDir, `${sessionId}.jsonl`);
        if (!existsSync(sessionFile)) {
          console.warn(`${logTag} target session ${sessionId} no longer exists; dropping delivery`);
          return "session_gone";
        }
        const session = new SessionManager(sessionId, sessionsDir);

        // Bump lastMessageAt so the UI surfaces the new activity.
        mutateSessionIndex(sessionsDir, (index) => {
          const meta = index.sessions.find((s) => s.id === sessionId);
          if (!meta) return false;
          meta.lastMessageAt = new Date().toISOString();
        });

        // Verbatim delivery: the body was composed by the producing run (a
        // cron digest); post it AS the agent's reply and let the activity room
        // refresh the transcript on bg_delivery_end. No re-inference turn.
        if (verbatim) {
          const already =
            alreadyAppended ||
            (await session.getMessages())
              .slice(-30)
              .some((m) => m.role === "assistant" && m.content.some((b) => b.type === "text" && b.text === message));
          if (!already) {
            await session.appendMessage({
              id: crypto.randomUUID(),
              timestamp: new Date().toISOString(),
              role: "assistant",
              content: [{ type: "text", text: message }],
              ...(provider ? { provider } : {}),
              ...(model ? { model } : {}),
            });
            onAppended?.();
            try { await session.flushIndex(); } catch { /* best-effort index flush */ }
          }
          wsBroadcast?.({ type: "bg_delivery_start", source, taskId, toolName, sessionId, agentId, status });
          wsBroadcast?.({ type: "bg_delivery_end", source, taskId, sessionId, agentId });
          return "delivered";
        }

        // Idempotent append: the outbox retries on "error", and the failure
        // may have happened AFTER this message landed. Primary signal is the
        // caller's DURABLE stamp (alreadyAppended); the exact-match scan of
        // the recent tail remains as crash-window fallback (a crash between
        // append and stamp-persist loses the stamp but not the row).
        const landed =
          alreadyAppended ||
          (await session.getMessages())
            .slice(-30)
            .some(
              (m) =>
                m.role === "user" &&
                m.content.some((b) => b.type === "text" && b.text === message),
            );
        if (!landed) {
          await session.appendMessage({
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            role: "user",
            // Mark as a harness delivery: retry/edit anchoring skips it (a
            // /retry after a background delivery re-runs the user's real ask,
            // not the [BACKGROUND TASK] block) and the UI can render it
            // distinctly.
            origin: "system-delivery",
            content: [{ type: "text", text: message }],
          });
          onAppended?.();
        }

        // Forward live events to connected WebSockets, tagged so the UI can
        // render inline (matching session) or as a badge (other session).
        // Injected at boot (see setSyntheticTurnBroadcast) — null in
        // tools-only / test contexts.
        const broadcast = wsBroadcast;

        broadcast?.({
          type: "bg_delivery_start",
          source,
          taskId,
          toolName,
          sessionId,
          agentId,
          status,
        });

        const turn = await runTriggeredAgentTurn({
          config,
          registry,
          deps: { localModelManager },
          agentId,
          session,
          signal: controller.signal,
          maxIterations,
          toolContextExtra: extraToolContext,
          onEvent: broadcast
            ? (event) => {
                broadcast!({ ...event, source, taskId, sessionId, agentId });
              }
            : undefined,
        });
        if (!turn.ok) {
          console.error(`${logTag} ${turn.error}`);
          return "error";
        }
        console.log(`${logTag} turn finished for session ${sessionId} (${turn.backendId}/${turn.model}, ${turn.outcome.stopCause})`);

        broadcast?.({
          type: "bg_delivery_end",
          source,
          taskId,
          sessionId,
          agentId,
        });

        // Map the loop's account of the turn to a delivery outcome. An abort
        // here is a preemption — the message already landed, so re-delivering
        // would duplicate it; the agent sees it on its next turn.
        const cause = turn.outcome.stopCause;
        if (cause === "aborted") {
          console.log(`${logTag} delivery preempted — message already persisted, not re-queuing`);
          return "delivered";
        }
        if (cause === "provider_error" || cause === "blank_response" || cause === "idle_timeout") {
          console.warn(`${logTag} delivery turn failed (${cause}${turn.outcome.error ? `: ${turn.outcome.error}` : ""})`);
          // Fatal provider kinds (expired auth, a request the provider
          // rejects outright) won't heal across retries — tell the outbox
          // to stop instead of re-burning the same failure for 24h.
          const kind = turn.outcome.errorKind;
          if (cause === "provider_error" && (kind === "auth" || kind === "bad_request")) {
            return "fatal_error";
          }
          return "error";
        }
        return "delivered";
      } catch (err) {
        // A genuine throw (session IO, transform crash). The append is
        // idempotent, so an outbox retry won't duplicate the message.
        console.error(`${logTag} delivery error:`, err instanceof Error ? err.message : err);
        return "error";
      }
    },
  );

  if (!locked.ok) {
    return locked.reason === "disposed" ? "disposed" : "lock_timeout";
  }
  return locked.value;
}
