// Regression tests for the identity-release lock model (M1-2 of the
// 2026-06 backend pass): a holder ALWAYS releases its own token; stale
// releases no-op; abortAgentLock leaves deletion to the unwinding holder
// so purge's drain-poll actually observes the loop stopping.

import { describe, test, expect } from "bun:test";
import {
  acquireAgentLock,
  releaseAgentLock,
  preemptAgentLock,
  abortAgentLock,
  isAgentLocked,
  registerAgentActivity,
  withAgentLock,
} from "./agent-lock.js";

// Module-level lock map is shared across tests — every test uses a unique
// agent id so they can't interfere.
let n = 0;
const uid = () => `lock-test-${++n}-${Math.random().toString(36).slice(2, 8)}`;

describe("identity release", () => {
  test("acquire returns a token; release with it frees the lock", () => {
    const id = uid();
    const token = acquireAgentLock(id, "cron");
    expect(token).not.toBeNull();
    expect(isAgentLocked(id)).toBe(true);
    releaseAgentLock(id, token!);
    expect(isAgentLocked(id)).toBe(false);
  });

  test("second acquire fails while held", () => {
    const id = uid();
    const token = acquireAgentLock(id, "cron");
    expect(acquireAgentLock(id, "chat")).toBeNull();
    releaseAgentLock(id, token!);
  });

  test("stale release (after preemption) does NOT free the successor's lock", () => {
    const id = uid();
    let aborted = false;
    const loserToken = acquireAgentLock(id, "cron", () => { aborted = true; })!;
    // Chat preempts: loser's abort fires, entry replaced.
    expect(preemptAgentLock(id, "chat")).toBe(true);
    expect(aborted).toBe(true);
    const winnerToken = acquireAgentLock(id, "chat")!;
    expect(winnerToken).not.toBeNull();
    // The preempted holder unwinds late and releases its own token — must
    // be a no-op against the winner's entry.
    releaseAgentLock(id, loserToken);
    expect(isAgentLocked(id)).toBe(true);
    releaseAgentLock(id, winnerToken);
    expect(isAgentLocked(id)).toBe(false);
  });

  test("equal/higher rank does not preempt", () => {
    const id = uid();
    const token = acquireAgentLock(id, "chat")!;
    expect(preemptAgentLock(id, "chat")).toBe(false);
    expect(preemptAgentLock(id, "cron")).toBe(false);
    releaseAgentLock(id, token);
  });
});

describe("abortAgentLock", () => {
  test("fires the holder's callback but leaves the entry for the holder to release", () => {
    const id = uid();
    let fired = false;
    const token = acquireAgentLock(id, "cron", () => { fired = true; })!;
    expect(abortAgentLock(id)).toBe(true);
    expect(fired).toBe(true);
    // Entry still present — purge's drain poll watches isAgentLocked.
    expect(isAgentLocked(id)).toBe(true);
    // The aborted holder unwinds and releases; the lock frees (this is
    // exactly the leak the old skip-on-abort heuristic caused).
    releaseAgentLock(id, token);
    expect(isAgentLocked(id)).toBe(false);
  });

  test("fires registered lock-free activities too", () => {
    const id = uid();
    let activityAborted = false;
    const unregister = registerAgentActivity(id, () => { activityAborted = true; });
    expect(abortAgentLock(id)).toBe(true);
    expect(activityAborted).toBe(true);
    unregister();
  });
});

describe("withAgentLock", () => {
  test("runs fn, releases on completion", async () => {
    const id = uid();
    const result = await withAgentLock(id, { owner: "cron", policy: "skip" }, async () => {
      expect(isAgentLocked(id)).toBe(true);
      return 42;
    });
    expect(result).toEqual({ ok: true, value: 42, preempted: false });
    expect(isAgentLocked(id)).toBe(false);
  });

  test("skip policy refuses while held", async () => {
    const id = uid();
    const token = acquireAgentLock(id, "chat")!;
    const result = await withAgentLock(id, { owner: "cron", policy: "skip" }, async () => 1);
    expect(result).toEqual({ ok: false, reason: "lock_busy" });
    releaseAgentLock(id, token);
  });

  test("preempt-lower takes over a lower-ranked holder; loser's release no-ops", async () => {
    const id = uid();
    let holderAborted = false;
    const loserToken = acquireAgentLock(id, "cron", () => { holderAborted = true; })!;
    const result = await withAgentLock(id, { owner: "chat", policy: "preempt-lower" }, async () => {
      // Simulate the preempted holder unwinding mid-run.
      releaseAgentLock(id, loserToken);
      expect(isAgentLocked(id)).toBe(true); // still ours
      return "ran";
    });
    expect(holderAborted).toBe(true);
    expect(result.ok).toBe(true);
    expect(isAgentLocked(id)).toBe(false);
  });

  test("releases even when aborted mid-run (the purge-leak regression)", async () => {
    const id = uid();
    const result = await withAgentLock(id, { owner: "cron", policy: "skip" }, async (controller) => {
      // Purge fires abortAgentLock while we're running.
      abortAgentLock(id);
      expect(controller.signal.aborted).toBe(true);
      return "aborted-but-finished";
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.preempted).toBe(true);
    // The CRITICAL assertion: the lock is FREE afterward. The old
    // skip-release-when-aborted heuristic leaked it forever here.
    expect(isAgentLocked(id)).toBe(false);
  });

  test("wait policy acquires after the holder releases", async () => {
    const id = uid();
    const token = acquireAgentLock(id, "chat")!;
    setTimeout(() => releaseAgentLock(id, token), 50);
    const result = await withAgentLock(
      id,
      { owner: "background", policy: "wait", waitMs: 5_000 },
      async () => "landed",
    );
    expect(result.ok).toBe(true);
    expect(isAgentLocked(id)).toBe(false);
  });
});
