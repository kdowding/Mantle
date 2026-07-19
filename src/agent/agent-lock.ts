// Agent-level mutex with ranked preemption.
//
// Owners are ranked: a requester preempts only a strictly lower-ranked
// holder, via the holder's abort callback. The ranks encode product intent:
//   chat (4)    — the user talking 1:1; outranks everything, preempted by
//                 nothing (never another chat either).
//   channel (3) — a group-chat sub-turn. User-initiated, so it outranks the
//                 background tier, but a direct 1:1 message still wins.
//   cron / background / subagent (1) — autonomous work; yields to anything
//                 user-shaped.
//
// Ownership is IDENTITY-based: acquireAgentLock returns a token (the entry
// object itself) and releaseAgentLock deletes only when the map still holds
// that exact token. A preempted or aborted holder therefore always calls
// release as it unwinds — if a successor already took the lock, the stale
// release is a no-op instead of stealing the successor's entry. This
// replaces the old release-skip-on-preempt heuristic (skip when
// signal.aborted), which leaked the entry forever when the holder was
// aborted WITHOUT a successor (abortAgentLock during purge/shutdown): the
// aborted loop skipped release, nothing else deleted it, and the agent
// stayed "locked" until a chat preempted.

export type LockOwner = "chat" | "channel" | "cron" | "background" | "subagent";

const OWNER_RANK: Record<LockOwner, number> = {
  chat: 4,
  channel: 3,
  cron: 1,
  background: 1,
  subagent: 1,
};

interface LockEntry {
  type: LockOwner;
  abort?: () => void;
}

// Opaque ownership proof — the entry object itself. Callers hold it only to
// hand it back to releaseAgentLock.
export type LockToken = LockEntry;

const locks = new Map<string, LockEntry>();

// Secondary, NON-blocking abort registry for agent work that deliberately
// runs without holding the mutex — today that's sub-agent child loops, which
// start while their parent still holds the lock (taking it would deadlock).
// They don't serialize against anything, but purge/shutdown still need a
// handle to stop them: abortAgentLock() fires these too.
const activities = new Map<string, Set<() => void>>();

export function registerAgentActivity(agentId: string, abort: () => void): () => void {
  let set = activities.get(agentId);
  if (!set) {
    set = new Set();
    activities.set(agentId, set);
  }
  set.add(abort);
  return () => {
    set.delete(abort);
    if (set.size === 0) activities.delete(agentId);
  };
}

// Listeners notified (fire-and-forget) when an agent lock is released — the
// moment a queued async delivery can most likely land. The delivery outbox
// registers here to drain. Kept out of the release path's critical section:
// we never await listeners, so unlock latency is unaffected.
type LockReleaseListener = (agentId: string) => void;
const releaseListeners: LockReleaseListener[] = [];

export function onAgentLockReleased(listener: LockReleaseListener): void {
  releaseListeners.push(listener);
}

/**
 * Take the agent lock. Returns the ownership token on success, null when the
 * lock is already held. Pass `abort` so preemptors / purge / shutdown can
 * cut the holder short (every holder should register one — including chat,
 * whose callback only ever fires via abortAgentLock since nothing outranks
 * it).
 */
export function acquireAgentLock(
  agentId: string,
  type: LockOwner = "chat",
  abort?: () => void,
): LockToken | null {
  if (locks.has(agentId)) return null;
  const entry: LockEntry = { type, abort };
  locks.set(agentId, entry);
  return entry;
}

/**
 * Release the lock IF `token` still owns it. Stale releases (the holder was
 * preempted and a successor owns the entry now) are silent no-ops, so
 * holders can — and must — release unconditionally as they unwind.
 */
export function releaseAgentLock(agentId: string, token: LockToken): void {
  if (locks.get(agentId) !== token) return;
  locks.delete(agentId);
  for (const listener of releaseListeners) {
    try {
      listener(agentId);
    } catch (err) {
      console.warn(`[MANTLE:agent-lock] release listener threw: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// Preempt the current holder on behalf of `requester`, if the requester
// outranks it. Returns true if the agent is now free (was unlocked, or the
// holder was aborted). The preempted owner's abort callback unwinds its
// loop; its own release later no-ops (identity mismatch) because we delete
// its entry here and the requester installs a new one.
export function preemptAgentLock(agentId: string, requester: LockOwner = "chat"): boolean {
  const entry = locks.get(agentId);
  if (!entry) return true;
  if (OWNER_RANK[entry.type] >= OWNER_RANK[requester]) return false;
  if (entry.abort) {
    try {
      entry.abort();
    } catch {
      // best effort — the holder's loop may already be unwinding
    }
  }
  locks.delete(agentId);
  return true;
}

// Abort whatever currently holds the agent lock, regardless of owner, by
// firing its abort callback — PLUS any registered lock-free activities
// (sub-agent child loops). Unlike preemptAgentLock this does NOT delete the
// entry: the aborted holder releases its own token as it unwinds (identity
// release guarantees it actually does now), so a caller can poll
// isAgentLocked() to wait until the loop has genuinely stopped touching
// state (agent purge does this before deleting the workspace). Returns true
// if any abort callback was fired.
export function abortAgentLock(agentId: string): boolean {
  let fired = false;
  const entry = locks.get(agentId);
  if (entry?.abort) {
    try {
      entry.abort();
      fired = true;
    } catch {
      // best effort
    }
  }
  const acts = activities.get(agentId);
  if (acts) {
    // Snapshot first — an abort callback typically unregisters itself,
    // mutating the set mid-iteration.
    const snapshot = Array.from(acts);
    for (const abort of snapshot) {
      try { abort(); fired = true; } catch { /* best effort */ }
    }
  }
  return fired;
}

export function isAgentLocked(agentId: string): boolean {
  return locks.has(agentId);
}

// ── withAgentLock — the packaged acquire/preempt/wait/release idiom ─────────

export interface LockOptions {
  owner: LockOwner;
  // What to do when the lock is held by someone else:
  //   "skip"          — return { ok:false, reason:"lock_busy" } immediately.
  //   "preempt-lower" — abort a lower-ranked holder and take over; busy-skip
  //                     when the holder ranks >= owner.
  //   "wait"          — poll until free (no preemption), up to waitMs.
  policy: "skip" | "preempt-lower" | "wait";
  waitMs?: number;       // for "wait"; default 60s
  // Polled while waiting — return true to give up (e.g. the producing
  // manager was disposed). Reported as reason:"disposed".
  shouldAbortWait?: () => boolean;
}

export type LockedRunResult<T> =
  | { ok: true; value: T; preempted: boolean }
  | { ok: false; reason: "lock_busy" | "lock_timeout" | "disposed" };

/**
 * Run `fn` while holding the agent lock. The controller passed to `fn` is
 * aborted if a higher-ranked owner preempts mid-run (or purge/shutdown
 * fires abortAgentLock); `fn` should thread `controller.signal` into its
 * loop. The holder ALWAYS releases its own token in the finally — when it
 * was preempted the release no-ops against the successor's entry, and when
 * it was aborted without a successor the release actually frees the lock
 * (the old skip-on-abort heuristic leaked it). `preempted` in the result
 * tells the caller the run was cut short rather than finishing.
 */
export async function withAgentLock<T>(
  agentId: string,
  opts: LockOptions,
  fn: (controller: AbortController) => Promise<T>,
): Promise<LockedRunResult<T>> {
  const controller = new AbortController();
  const abortCb = () => controller.abort();

  let token = acquireAgentLock(agentId, opts.owner, abortCb);
  if (!token) {
    if (opts.policy === "skip") return { ok: false, reason: "lock_busy" };
    if (opts.policy === "preempt-lower") {
      if (!preemptAgentLock(agentId, opts.owner)) return { ok: false, reason: "lock_busy" };
      token = acquireAgentLock(agentId, opts.owner, abortCb);
      if (!token) return { ok: false, reason: "lock_busy" };
    } else {
      // "wait": poll until the holder releases. No preemption — waiting is
      // for deliveries that should land between turns, not interrupt them.
      const waitMs = opts.waitMs ?? 60_000;
      const pollMs = 500;
      const start = Date.now();
      for (;;) {
        if (opts.shouldAbortWait?.()) return { ok: false, reason: "disposed" };
        token = acquireAgentLock(agentId, opts.owner, abortCb);
        if (token) break;
        if (Date.now() - start > waitMs) return { ok: false, reason: "lock_timeout" };
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }
  }

  try {
    const value = await fn(controller);
    return { ok: true, value, preempted: controller.signal.aborted };
  } finally {
    releaseAgentLock(agentId, token);
  }
}
