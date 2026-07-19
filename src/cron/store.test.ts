// Regression tests for the cron store fixes (M5): bound LIMIT/OFFSET
// (offset-without-limit used to render invalid SQL), honored limit=0, and
// the atomic json_set markRunning.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CronStore } from "./store.js";
import type { CronJob } from "./types.js";

let store: CronStore;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "mantle-cron-"));
  store = new CronStore(join(dir, "cron.db"));
});

function makeJob(name: string, agentId = "juno"): CronJob {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    agentId,
    name,
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    createdBy: "user",
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    payload: { message: "tick" },
    priority: "normal",
    state: { consecutiveErrors: 0, scheduleErrorCount: 0, totalRuns: 0, totalErrors: 0 },
  };
}

describe("listJobs paging", () => {
  test("offset WITHOUT limit works (used to be an SQL syntax error)", () => {
    for (let i = 0; i < 5; i++) store.addJob(makeJob(`j${i}`));
    const page = store.listJobs({ offset: 2 });
    expect(page).toHaveLength(3);
  });

  test("limit + offset page correctly", () => {
    for (let i = 0; i < 5; i++) store.addJob(makeJob(`j${i}`));
    expect(store.listJobs({ limit: 2 })).toHaveLength(2);
    expect(store.listJobs({ limit: 2, offset: 4 })).toHaveLength(1);
  });

  test("limit 0 returns nothing (used to be falsy-dropped)", () => {
    store.addJob(makeJob("only"));
    expect(store.listJobs({ limit: 0 })).toHaveLength(0);
  });

  test("agent filter + enabled filter compose", () => {
    store.addJob(makeJob("a", "juno"));
    const disabled = makeJob("b", "echo");
    disabled.enabled = false;
    store.addJob(disabled);
    expect(store.listJobs({ agentId: "juno" })).toHaveLength(1);
    expect(store.listJobs({ enabled: false })).toHaveLength(1);
    expect(store.listJobs({ agentId: "echo", enabled: true })).toHaveLength(0);
  });
});

describe("markRunning", () => {
  test("sets ONLY runningAtMs, atomically — other fields untouched", () => {
    const job = makeJob("atomic");
    job.state.lastRunAtMs = 12345;
    job.state.consecutiveErrors = 2;
    store.addJob(job);

    store.markRunning(job.id, 99999);
    const fresh = store.getJob(job.id)!;
    expect(fresh.state.runningAtMs).toBe(99999);
    expect(fresh.state.lastRunAtMs).toBe(12345);
    expect(fresh.state.consecutiveErrors).toBe(2);
    expect(fresh.payload.message).toBe("tick");
  });

  test("running jobs are excluded from getDueJobs", () => {
    const job = makeJob("due");
    job.state.nextRunAtMs = Date.now() - 1000;
    store.addJob(job);
    expect(store.getDueJobs(Date.now())).toHaveLength(1);
    store.markRunning(job.id, Date.now());
    expect(store.getDueJobs(Date.now())).toHaveLength(0);
  });
});

describe("clearStaleRunning", () => {
  test("clears crash-orphaned running markers", () => {
    const job = makeJob("stale");
    store.addJob(job);
    store.markRunning(job.id, Date.now());
    expect(store.clearStaleRunning()).toBe(1);
    expect(store.getJob(job.id)!.state.runningAtMs).toBeUndefined();
  });
});

// ── cron v2 surface: snooze parsing + delivery defaults ──────────────────────

import { parseSnoozeDelay, deliveryMode, validateDeliveryMode, SNOOZE_MIN_MS, SNOOZE_MAX_MS } from "./types.js";

describe("parseSnoozeDelay", () => {
  test("unit forms parse", () => {
    expect(parseSnoozeDelay("30m")).toBe(30 * 60_000);
    expect(parseSnoozeDelay("2h")).toBe(2 * 3_600_000);
    expect(parseSnoozeDelay("1d")).toBe(86_400_000);
    expect(parseSnoozeDelay("90s")).toBe(90_000);
  });
  test("bare numbers are minutes", () => {
    expect(parseSnoozeDelay("45")).toBe(45 * 60_000);
    expect(parseSnoozeDelay(45)).toBe(45 * 60_000);
  });
  test("clamped to [1m, 7d]", () => {
    expect(parseSnoozeDelay("5s")).toBe(SNOOZE_MIN_MS);
    expect(parseSnoozeDelay("30d")).toBe(SNOOZE_MAX_MS);
  });
  test("garbage is null, not a clamp", () => {
    expect(parseSnoozeDelay("soon")).toBeNull();
    expect(parseSnoozeDelay("")).toBeNull();
    expect(parseSnoozeDelay(undefined)).toBeNull();
    expect(parseSnoozeDelay(NaN)).toBeNull();
  });
});

describe("delivery contract", () => {
  test("legacy jobs (no field) default to agent-decides", () => {
    expect(deliveryMode(makeJob("legacy"))).toBe("agent");
  });
  test("explicit mode round-trips through the store", () => {
    const job = makeJob("noisy");
    job.delivery = { mode: "message" };
    store.addJob(job);
    expect(deliveryMode(store.getJob(job.id)!)).toBe("message");
  });
  test("validateDeliveryMode accepts the four modes, rejects junk", () => {
    for (const mode of ["silent", "notify", "message", "agent"]) {
      expect(validateDeliveryMode({ mode })).toBeNull();
    }
    expect(validateDeliveryMode({ mode: "loud" })).toContain("Invalid delivery mode");
    expect(validateDeliveryMode(undefined)).toBeNull(); // absent = default
  });
});
