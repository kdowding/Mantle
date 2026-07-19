// Durable delivery outbox for async results (sub-agent + background tasks).
//
// The problem it fixes: deliverSyntheticTurn used to wait up to 60s for the
// per-agent lock and then, if a chat turn was still holding it, silently drop
// the result ("result left pending" + return). Autonomous work — a sub-agent's
// findings, a background research result — vanished whenever the agent stayed
// busy, and ANY pending delivery was lost on restart.
//
// This makes async delivery the single durable path:
//   1. The producer ENQUEUES a serializable record to
//      .mantle/sessions/<agentId>/pending-deliveries.jsonl (survives restart).
//   2. drainAgent() attempts each pending delivery via deliverSyntheticTurn,
//      which now REPORTS an outcome instead of dropping. Delivered → removed;
//      target gone → discarded; lock busy / shutting down → left pending for a
//      later trigger.
//   3. Triggers: fire-and-forget after any agent lock releases (a chat turn
//      finishing frees the agent → drain its queue), and a boot-time replay.
//
// Delivery is at-least-once, but the append is idempotent: before appending,
// deliverSyntheticTurn scans the session tail for an identical message text
// (stable across retries — it's persisted verbatim in the entry), so a retry
// or crash-replay after a landed append re-runs the agent turn without
// stacking duplicate notifications.

import { resolve, dirname } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "fs";
import type { MantleConfig } from "../config/schema.js";
import type { LocalModelManager } from "../local/manager.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import { deliverSyntheticTurn, type DeliveryOutcome } from "./synthetic-turn.js";
import { onAgentLockReleased } from "./agent-lock.js";

export interface OutboxDeps {
  config: MantleConfig;
  registry: ToolRegistry;
  localModelManager?: LocalModelManager;
}

// The persisted, serializable shape of a queued delivery.
export interface PendingDelivery {
  id: string;
  agentId: string;
  sessionId: string;
  message: string;
  source: "background" | "subagent" | "cron";
  toolName: string;
  taskId: string;
  status: string; // the delivered task's status (complete/failed/...)
  maxIterations?: number;
  subagentDepth?: number; // serializable slice of extraToolContext
  // Verbatim delivery (cron): post `message` as the agent's reply, no turn.
  verbatim?: boolean;
  provider?: string; // stamped onto the verbatim assistant row
  model?: string;
  state: "pending" | "delivered" | "discarded";
  // Durable "the synthetic message is in the transcript" stamp — set the
  // moment the append lands so a retry never re-appends, even when the
  // session tail has scrolled past the fallback scan window.
  appended?: boolean;
  attemptCount: number;
  lastError?: string;
  discardReason?: string;
  enqueuedAt: string;
  updatedAt: string;
}

// Non-serializable extras that only exist in the enqueuing process. Lets a
// SAME-PROCESS drain keep the live subagentManager (so a delivered sub-agent
// turn can still spawn) and the producer's disposed check. Lost on restart;
// replay degrades gracefully (no manager → spawn returns a clean error,
// isDisposed defaults to false).
interface LiveExtra {
  subagentManager?: ToolContext["subagentManager"];
  isDisposed?: () => boolean;
}

export interface EnqueueParams {
  agentId: string;
  sessionId: string;
  message: string;
  source: "background" | "subagent" | "cron";
  toolName: string;
  taskId: string;
  status: string;
  maxIterations?: number;
  subagentDepth?: number;
  // Verbatim cron delivery: post `message` AS the agent's reply (no re-voice
  // turn). provider/model stamp the resulting assistant row honestly.
  verbatim?: boolean;
  provider?: string;
  model?: string;
}

// Give up re-delivering after this many failed attempts or this much age,
// whichever comes first — bounds a poison entry instead of retrying forever.
const MAX_ATTEMPTS = 6;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// The outbox retries on every lock release, so a per-attempt lock wait of
// minutes is pointless — fail fast and let the next trigger pick it up.
const OUTBOX_LOCK_WAIT_MS = 3_000;

let deps: OutboxDeps | null = null;
const liveExtras = new Map<string, LiveExtra>();
const draining = new Set<string>(); // per-agent re-entrancy guard

export function initDeliveryOutbox(d: OutboxDeps): void {
  deps = d;
  // A freed agent lock is the moment a queued delivery can most likely land.
  // Fire-and-forget so we never serialize the unlock path.
  onAgentLockReleased((agentId) => {
    void drainAgent(agentId);
  });
}

function fileFor(agentId: string): string {
  return resolve(deps!.config.basePath, ".mantle", "sessions", agentId, "pending-deliveries.jsonl");
}

function readEntries(agentId: string): PendingDelivery[] {
  const p = fileFor(agentId);
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as PendingDelivery;
        } catch {
          return null;
        }
      })
      .filter((e): e is PendingDelivery => e !== null);
  } catch {
    return [];
  }
}

// Persist only the still-pending entries — delivered/discarded ones drop out
// here, keeping the file small. Read-modify-write is synchronous so there's no
// await window where a concurrent enqueue could be clobbered. Temp + rename
// (the session-index idiom) so a crash mid-write can't tear the very queue
// that exists to survive crashes.
function persist(agentId: string, entries: PendingDelivery[]): void {
  const keep = entries.filter((e) => e.state === "pending");
  const p = fileFor(agentId);
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, keep.map((e) => JSON.stringify(e)).join("\n") + (keep.length ? "\n" : ""));
    renameSync(tmp, p);
  } catch (err) {
    console.warn(`[MANTLE:outbox] failed to persist ${agentId}: ${err instanceof Error ? err.message : err}`);
  }
}

export function enqueueDelivery(params: EnqueueParams, live?: LiveExtra): string {
  if (!deps) {
    console.warn("[MANTLE:outbox] enqueue before init — dropping (should never happen post-boot)");
    return "";
  }
  const now = new Date().toISOString();
  const entry: PendingDelivery = {
    ...params,
    id: `del-${crypto.randomUUID().slice(0, 12)}`,
    state: "pending",
    attemptCount: 0,
    enqueuedAt: now,
    updatedAt: now,
  };
  const entries = readEntries(params.agentId);
  entries.push(entry);
  persist(params.agentId, entries);
  if (live) liveExtras.set(entry.id, live);
  return entry.id;
}

function isExpired(entry: PendingDelivery): boolean {
  if (entry.attemptCount >= MAX_ATTEMPTS) return true;
  const age = Date.now() - new Date(entry.enqueuedAt).getTime();
  return age > MAX_AGE_MS;
}

async function attemptDelivery(entry: PendingDelivery): Promise<DeliveryOutcome> {
  const extra = liveExtras.get(entry.id);
  const extraToolContext: Partial<ToolContext> | undefined =
    entry.source === "subagent"
      ? { subagentManager: extra?.subagentManager, subagentDepth: entry.subagentDepth }
      : undefined;
  return deliverSyntheticTurn({
    config: deps!.config,
    registry: deps!.registry,
    localModelManager: deps!.localModelManager,
    agentId: entry.agentId,
    sessionId: entry.sessionId,
    message: entry.message,
    source: entry.source,
    toolName: entry.toolName,
    taskId: entry.taskId,
    status: entry.status,
    maxIterations: entry.maxIterations,
    isDisposed: extra?.isDisposed ?? (() => false),
    extraToolContext,
    logTag: `[MANTLE:outbox] ${entry.taskId}`,
    lockWaitMs: OUTBOX_LOCK_WAIT_MS,
    alreadyAppended: entry.appended === true,
    onAppended: () => stampAppended(entry.agentId, entry.id),
    verbatim: entry.verbatim,
    provider: entry.provider,
    model: entry.model,
  });
}

// Persist the durable append stamp the moment the synthetic message lands —
// a retry after a post-append failure must re-run the TURN, never re-append
// the message.
function stampAppended(agentId: string, id: string): void {
  const entries = readEntries(agentId);
  const t = entries.find((e) => e.id === id);
  if (t && !t.appended) {
    t.appended = true;
    t.updatedAt = new Date().toISOString();
    persist(agentId, entries);
  }
}

// Attempt every pending delivery for one agent, oldest first. Guarded so the
// lock-release hook (which fires again when a delivery finishes and releases
// the lock) can't re-enter mid-drain. Stops early on a busy lock / shutdown so
// it doesn't hot-spin — the next trigger resumes.
export async function drainAgent(agentId: string): Promise<void> {
  if (!deps || draining.has(agentId)) return;
  draining.add(agentId);
  try {
    // Bounded by the pending count + the FIFO removal/discard each pass makes,
    // so this can't loop forever even if a trigger races in.
    for (;;) {
      const pending = readEntries(agentId).filter((e) => e.state === "pending");
      if (pending.length === 0) break;
      const entry = pending[0];

      if (isExpired(entry)) {
        finalize(agentId, entry.id, "discarded", `expired after ${entry.attemptCount} attempt(s)`);
        console.warn(`[MANTLE:outbox] discarded ${entry.taskId} (${entry.source}) — expired`);
        continue;
      }

      const outcome = await attemptDelivery(entry);

      if (outcome === "delivered") {
        finalize(agentId, entry.id, "delivered");
        continue;
      }
      if (outcome === "session_gone") {
        finalize(agentId, entry.id, "discarded", "target session/agent gone");
        console.warn(`[MANTLE:outbox] discarded ${entry.taskId} — target gone`);
        continue;
      }
      if (outcome === "lock_timeout" || outcome === "disposed") {
        // Agent busy or shutting down — leave pending, retry on the next lock
        // release / boot. Stop now rather than spinning the same head entry.
        break;
      }
      if (outcome === "fatal_error") {
        // The provider classified the failure as unfixable-by-retry (auth /
        // bad_request) — the message is idempotently appended, so the agent
        // still sees it on its next working turn; re-running the turn would
        // just re-burn the same failure.
        finalize(agentId, entry.id, "discarded", "fatal provider error (auth/bad_request)");
        console.warn(`[MANTLE:outbox] discarded ${entry.taskId} — fatal provider error, not retrying`);
        continue;
      }
      // outcome === "error": bump the attempt count, rotate the entry to the
      // tail (a poison head must not block every later delivery for up to
      // MAX_ATTEMPTS lock-release cycles), and stop; a later trigger retries
      // until MAX_ATTEMPTS trips isExpired.
      bumpAttempt(agentId, entry.id, "delivery error", { rotateToTail: true });
      break;
    }
  } finally {
    draining.delete(agentId);
    // Idle-agent backstop (OUTBOX-4): retries normally piggyback on lock
    // releases, but an agent with no chat/heartbeat traffic never releases a
    // lock — an errored entry would sit until reboot. One lazy timer per
    // agent re-drains after a minute; unref'd so it never holds shutdown open.
    if (readEntries(agentId).some((e) => e.state === "pending")) {
      scheduleRetry(agentId);
    }
  }
}

const RETRY_DELAY_MS = 60_000;
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleRetry(agentId: string): void {
  if (retryTimers.has(agentId)) return;
  const t = setTimeout(() => {
    retryTimers.delete(agentId);
    void drainAgent(agentId);
  }, RETRY_DELAY_MS);
  (t as unknown as { unref?: () => void }).unref?.();
  retryTimers.set(agentId, t);
}

function finalize(agentId: string, id: string, state: "delivered" | "discarded", reason?: string): void {
  const entries = readEntries(agentId);
  const t = entries.find((e) => e.id === id);
  if (t) {
    t.state = state;
    t.discardReason = reason;
    t.updatedAt = new Date().toISOString();
  }
  persist(agentId, entries); // delivered/discarded are filtered out on write
  liveExtras.delete(id);
}

function bumpAttempt(
  agentId: string,
  id: string,
  error: string,
  opts?: { rotateToTail?: boolean },
): void {
  const entries = readEntries(agentId);
  const t = entries.find((e) => e.id === id);
  if (t) {
    t.attemptCount += 1;
    t.lastError = error;
    t.updatedAt = new Date().toISOString();
    if (t.attemptCount >= MAX_ATTEMPTS) {
      t.state = "discarded";
      t.discardReason = `gave up after ${t.attemptCount} attempts: ${error}`;
      liveExtras.delete(id);
      console.warn(`[MANTLE:outbox] discarded ${t.taskId} — ${t.discardReason}`);
    } else if (opts?.rotateToTail) {
      // Move the failed entry behind the others so the next drain attempts a
      // different head. Costs strict FIFO ordering on failure, which is the
      // point — deliveries are independent notifications, not a sequence.
      const idx = entries.indexOf(t);
      entries.splice(idx, 1);
      entries.push(t);
    }
  }
  persist(agentId, entries);
}

// On boot, re-attempt anything that was pending when the process last stopped.
export async function replayAllDeliveries(): Promise<void> {
  if (!deps) return;
  const root = resolve(deps.config.basePath, ".mantle", "sessions");
  if (!existsSync(root)) return;
  let total = 0;
  let agentDirs: string[] = [];
  try {
    agentDirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return;
  }
  for (const agentId of agentDirs) {
    const pending = readEntries(agentId).filter((e) => e.state === "pending");
    if (pending.length > 0) {
      total += pending.length;
      void drainAgent(agentId);
    }
  }
  if (total > 0) {
    console.log(`[MANTLE:outbox] replaying ${total} pending delivery(ies) on boot`);
  }
}
