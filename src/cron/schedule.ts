import { Cron } from "croner";
import type { CronSchedule } from "./types.js";
import { errorBackoffMs } from "./types.js";

// ── Duration Parsing ────────────────────────────────────────────────────────

const DURATION_RE = /^(\d+)\s*(s|sec|m|min|h|hr|d|ms)$/i;

export function parseDurationMs(duration: string): number | null {
  const match = duration.match(DURATION_RE);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "ms": return value;
    case "s": case "sec": return value * 1_000;
    case "m": case "min": return value * 60_000;
    case "h": case "hr": return value * 3_600_000;
    case "d": return value * 86_400_000;
    default: return null;
  }
}

// ── Relative Time Parsing ───────────────────────────────────────────────────

export function resolveAtTime(at: string, nowMs: number = Date.now()): number | null {
  // Try relative duration first ("20m", "1h", "2d")
  const durationMs = parseDurationMs(at);
  if (durationMs !== null) {
    return nowMs + durationMs;
  }

  // Try ISO 8601 date
  const ts = new Date(at).getTime();
  if (!isNaN(ts)) {
    return ts;
  }

  return null;
}

// ── Next Run Computation ────────────────────────────────────────────────────

export function computeNextRunAtMs(
  schedule: CronSchedule,
  opts?: {
    nowMs?: number;
    lastRunAtMs?: number;
    consecutiveErrors?: number;
    createdAtMs?: number;
  },
): number | null {
  const nowMs = opts?.nowMs ?? Date.now();
  const lastRunAtMs = opts?.lastRunAtMs;
  const consecutiveErrors = opts?.consecutiveErrors ?? 0;

  let naturalNext: number | null = null;

  switch (schedule.kind) {
    case "at": {
      // One-shot: fire at the specified time
      const target = resolveAtTime(schedule.at, opts?.createdAtMs ?? nowMs);
      if (target === null) return null;
      // If the target is in the past and it hasn't run yet, fire immediately
      naturalNext = target;
      break;
    }

    case "every": {
      const anchorMs = schedule.anchorMs ?? opts?.createdAtMs ?? nowMs;
      if (lastRunAtMs) {
        // Next interval after last run
        naturalNext = lastRunAtMs + schedule.everyMs;
        // If that's in the past, advance to next future slot
        while (naturalNext <= nowMs) {
          naturalNext += schedule.everyMs;
        }
      } else {
        // First run: next interval after anchor
        naturalNext = anchorMs + schedule.everyMs;
        while (naturalNext <= nowMs) {
          naturalNext += schedule.everyMs;
        }
      }
      break;
    }

    case "cron": {
      try {
        const cron = new Cron(schedule.expr, {
          timezone: schedule.tz,
        });
        const next = cron.nextRun(new Date(nowMs));
        naturalNext = next ? next.getTime() : null;
      } catch {
        return null; // Invalid expression
      }
      break;
    }
  }

  if (naturalNext === null) return null;

  // Apply error backoff if there are consecutive errors
  if (consecutiveErrors > 0 && lastRunAtMs) {
    const backoff = errorBackoffMs(consecutiveErrors);
    const backoffNext = lastRunAtMs + backoff;
    return Math.max(naturalNext, backoffNext);
  }

  return naturalNext;
}

// ── Schedule Description ────────────────────────────────────────────────────

export function describeSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case "at":
      return `once at ${schedule.at}`;
    case "every":
      return `every ${formatDuration(schedule.everyMs)}`;
    case "cron":
      return `cron: ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ""}`;
  }
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

// ── Validation ──────────────────────────────────────────────────────────────

export function validateSchedule(schedule: CronSchedule): string | null {
  switch (schedule.kind) {
    case "at": {
      const target = resolveAtTime(schedule.at);
      if (target === null) return `Invalid "at" value: ${schedule.at}. Use ISO 8601 or relative duration (e.g., "20m", "1h").`;
      return null;
    }
    case "every": {
      if (!Number.isFinite(schedule.everyMs) || schedule.everyMs < 60_000) {
        return `Interval must be at least 60000ms (1 minute). Got: ${schedule.everyMs}`;
      }
      return null;
    }
    case "cron": {
      try {
        new Cron(schedule.expr, { timezone: schedule.tz });
        return null;
      } catch (err) {
        return `Invalid cron expression: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    default:
      return `Unknown schedule kind: ${(schedule as { kind: string }).kind}`;
  }
}
