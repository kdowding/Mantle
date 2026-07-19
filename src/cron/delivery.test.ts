import { describe, test, expect } from "bun:test";
import { threadSessionId, buildThreadBody, planPing, deliveredStamp, THREAD_BODY_MAX } from "./delivery.js";
import { verdictOnly, type CronRunResult, type CronReport } from "./types.js";

function ok(extra?: Partial<CronRunResult>): CronRunResult {
  return { status: "ok", durationMs: 1000, ...extra };
}

describe("threadSessionId", () => {
  test("deterministic, distinct from the workspace prefix", () => {
    const id = threadSessionId("d751a34f-66bc-4652-b7bf-488dab40f48c");
    expect(id).toBe("cron-thread-d751a34f");
    // The deck's workspace matcher is a `cron-<jobId8>` prefix — the thread
    // id must NOT match it.
    expect(id.startsWith("cron-d751a34f")).toBe(false);
  });
});

describe("buildThreadBody", () => {
  test("skipped runs file nothing", () => {
    expect(buildThreadBody({ status: "skipped", durationMs: 0 })).toBeNull();
  });

  test("errors file a failure notice", () => {
    expect(buildThreadBody({ status: "error", error: "boom", durationMs: 5 })).toBe(
      "⚠ Scheduled run failed — boom",
    );
    expect(buildThreadBody({ status: "error", durationMs: 5 })).toContain("unknown error");
  });

  test("a 'nothing' verdict files its one-liner, not the full message", () => {
    const body = buildThreadBody(
      ok({
        report: { status: "nothing", summary: "checked, no changes" },
        message: "a long ramble that should not be filed",
      }),
    );
    expect(body).toBe("checked, no changes");
  });

  test("ok files the full message, falling back to summary, then placeholder", () => {
    expect(buildThreadBody(ok({ message: "## Digest\n\nfull text", summary: "one line" }))).toBe(
      "## Digest\n\nfull text",
    );
    expect(buildThreadBody(ok({ summary: "one line" }))).toBe("one line");
    expect(buildThreadBody(ok({}))).toBe("(run completed but produced no report)");
  });

  test("problem verdicts file the full message like ok", () => {
    const body = buildThreadBody(
      ok({ report: { status: "problem", summary: "s" }, message: "needs attention: details" }),
    );
    expect(body).toBe("needs attention: details");
  });

  test("oversized bodies truncate with a marker", () => {
    const body = buildThreadBody(ok({ message: "x".repeat(THREAD_BODY_MAX + 100) }))!;
    expect(body.length).toBeLessThan(THREAD_BODY_MAX + 50);
    expect(body.endsWith("[… report truncated]")).toBe(true);
  });
});

describe("planPing", () => {
  test("skipped runs never ping", () => {
    expect(planPing("message", { status: "skipped", durationMs: 0 })).toBeNull();
  });

  test("errors toast on every mode except silent", () => {
    const err: CronRunResult = { status: "error", error: "e", durationMs: 1 };
    expect(planPing("message", err)).toBe("notify");
    expect(planPing("agent", err)).toBe("notify");
    expect(planPing("notify", err)).toBe("notify");
    expect(planPing("silent", err)).toBeNull();
  });

  test("ok runs follow the mode; agent mode follows the report's notify flag", () => {
    expect(planPing("message", ok())).toBe("message");
    expect(planPing("notify", ok())).toBe("notify");
    expect(planPing("silent", ok())).toBeNull();
    expect(planPing("agent", ok())).toBeNull(); // no report → quiet
    expect(planPing("agent", ok({ report: { status: "ok", summary: "s", notify: false } }))).toBeNull();
    expect(planPing("agent", ok({ report: { status: "ok", summary: "s", notify: true } }))).toBe("message");
  });
});

describe("deliveredStamp", () => {
  test("ping wins, then thread, then none", () => {
    expect(deliveredStamp(true, "message")).toBe("message");
    expect(deliveredStamp(true, "notify")).toBe("notify");
    expect(deliveredStamp(true, null)).toBe("thread");
    expect(deliveredStamp(false, null)).toBe("none");
  });
});

describe("verdictOnly", () => {
  test("strips the message body, keeps the verdict", () => {
    const report: CronReport = { status: "ok", summary: "s", notify: true, message: "big body" };
    expect(verdictOnly(report)).toEqual({ status: "ok", summary: "s", notify: true });
    expect("message" in verdictOnly(report)).toBe(false);
  });
});
