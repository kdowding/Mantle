// Cron delivery planning — pure logic for WHERE a finished run's output goes.
//
// Two layers, decided independently:
//   1. The job THREAD (`cron-thread-<jobId8>`): the durable per-job record.
//      Every consequential run files its report there — it's what the user
//      pulls up in the cron deck, and it's a real session they can reply
//      into (the next run reads that steering).
//   2. The PING: whether this run additionally interrupts the user right
//      now — a chat mirror ("message") or a toast ("notify") — per the job's
//      delivery mode. The thread is the record; the ping is the knock on
//      the door.
//
// Kept free of fs/config so the whole decision matrix is unit-testable;
// executor.ts owns the side effects (session creation, outbox enqueue).

import type { CronDeliveryMode, CronRunResult } from "./types.js";

// One thread per job, deterministic id. Distinct from the run-workspace
// prefix `cron-<jobId8>-…` / `cron-<jobId8>` so the deck's workspace listing
// (a `cron-<jobId8>` prefix match) never swallows it.
export function threadSessionId(jobId: string): string {
  return `cron-thread-${jobId.slice(0, 8)}`;
}

// Cap a thread body so a runaway lastAssistantText can't bloat the thread
// JSONL — real reports are a few KB.
export const THREAD_BODY_MAX = 32_000;

// What this run files into the job thread. null = nothing to file: a skipped
// run never happened (lock collision / conditional miss), and filing skips
// would spam the thread every time a fire lands mid-chat.
export function buildThreadBody(result: CronRunResult): string | null {
  if (result.status === "skipped") return null;
  if (result.status === "error") {
    return `⚠ Scheduled run failed — ${result.error ?? "unknown error"}`;
  }
  // A "nothing" verdict files its one-liner: the thread stays an honest
  // heartbeat ("checked, nothing new") without drowning the real reports.
  if (result.report?.status === "nothing") {
    return result.report.summary || result.summary || "Nothing new.";
  }
  const body = result.message?.trim() || result.summary?.trim();
  if (!body) return "(run completed but produced no report)";
  return body.length > THREAD_BODY_MAX
    ? `${body.slice(0, THREAD_BODY_MAX)}\n\n[… report truncated]`
    : body;
}

export type CronPing = "message" | "notify" | null;

// Whether this run interrupts the user beyond the thread record. Errors
// surface as a toast on every mode except an explicit "silent" (the thread
// still records them; auto-disable escalates separately and unconditionally).
export function planPing(mode: CronDeliveryMode, result: CronRunResult): CronPing {
  if (result.status === "skipped") return null;
  if (result.status === "error") return mode === "silent" ? null : "notify";
  switch (mode) {
    case "message":
      return "message";
    case "agent":
      return result.report?.notify === true ? "message" : null;
    case "notify":
      return "notify";
    case "silent":
      return null;
  }
}

// The run-log `delivered` stamp for a filed/pinged combination — what
// actually reached the user this run. "message"/"notify" imply the thread
// was also filed; "thread" = record only; "none" = nothing anywhere.
export function deliveredStamp(
  filed: boolean,
  ping: CronPing,
): "message" | "notify" | "thread" | "none" {
  if (ping === "message") return "message";
  if (ping === "notify") return "notify";
  return filed ? "thread" : "none";
}
