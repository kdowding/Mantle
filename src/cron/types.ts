// ── Schedule Types ──────────────────────────────────────────────────────────

export type CronScheduleAt = { kind: "at"; at: string }; // ISO 8601 or relative ("20m", "1h")
export type CronScheduleEvery = { kind: "every"; everyMs: number; anchorMs?: number };
export type CronScheduleCron = { kind: "cron"; expr: string; tz?: string };
export type CronSchedule = CronScheduleAt | CronScheduleEvery | CronScheduleCron;

// ── Priority ────────────────────────────────────────────────────────────────

export type CronPriority = "low" | "normal" | "high" | "critical";

// ── Run context (per-job prompt scope) ──────────────────────────────────────
// How much of the agent's identity + memory a scheduled run loads, at what
// recall depth. A preset (cron/presets.ts) supplies the defaults; a job may
// override individual fields. This is ECONOMY (don't pay for SOUL/memory a
// crawl-and-report job doesn't use), not security — the safety floor (AGENTS.md
// is in every preset) and the tool surface are what bound an autonomous run.
export type CronWorkspaceFile = "AGENTS" | "SOUL" | "IDENTITY" | "USER" | "MEMORY";

export interface CronContext {
  workspaceFiles?: CronWorkspaceFile[];  // identity files to render; omit → preset's set
  memoryPack?: boolean;                  // pre-inference Englyph recall pack (off pre-presets)
  skills?: boolean;                      // standing skills + the triggered catalog
  baseline?: boolean;                    // the always-loaded MANTLE.md operating manual
}

export type CronPresetName = "mechanical" | "aware" | "companion";

// ── Payload ─────────────────────────────────────────────────────────────────

export interface CronPayload {
  message: string;
  // Composite backend id or legacy name — resolveProviderTurn accepts both.
  provider?: string;
  model?: string;
  toolsAllow?: string[];
  maxIterations?: number;
  thinkingLevel?: "off" | "low" | "medium" | "high";
  // Named context+tools preset (cron/presets.ts). Absent → the security-first
  // default (mechanical: lean context, read+report tools). Seeds the run's
  // prompt scope + tool surface.
  preset?: CronPresetName;
  // Per-job context overrides layered over the preset (advanced; REST/UI).
  context?: CronContext;
  // Egress allow-list (domain suffixes) for the run's net-guarded fetch tools
  // (web_fetch, attach_url_file). When set, the run can reach ONLY these domains
  // — the keystone containment for crawl-and-report jobs (the target domains ARE
  // the job spec). Absent = no restriction (the SSRF block still applies).
  egressDomains?: string[];
}

// ── Delivery ────────────────────────────────────────────────────────────────
// Where a run's outcome lands. "silent" = transcript + run log only (the
// pre-delivery behavior). "notify" = a WS toast. "message" = the result is
// delivered INTO the user's chat via the durable outbox (the agent speaks).
// "agent" (default) = the agent decides per run via cron_report's notify
// flag — quiet when nothing happened, a chat message when it matters.
export type CronDeliveryMode = "silent" | "notify" | "message" | "agent";

export interface CronDelivery {
  mode: CronDeliveryMode;
}

export function validateDeliveryMode(value: unknown): string | null {
  if (value === undefined) return null;
  const mode = (value as { mode?: unknown })?.mode;
  if (mode === "silent" || mode === "notify" || mode === "message" || mode === "agent") return null;
  return `Invalid delivery mode "${String(mode)}" — use "silent", "notify", "message", or "agent"`;
}

export function deliveryMode(job: CronJob): CronDeliveryMode {
  return job.delivery?.mode ?? "agent"; // legacy rows (no field) get the default
}

// ── cron_snooze delay parsing ───────────────────────────────────────────────
export const SNOOZE_MIN_MS = 60_000;
export const SNOOZE_MAX_MS = 7 * 24 * 3_600_000;

// "30m" / "2h" / "1d" / "90s" / bare minutes ("45" or 45). null = unparseable.
// Always clamped to [1m, 7d].
export function parseSnoozeDelay(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return clampSnooze(raw * 60_000);
  }
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? "m").toLowerCase();
  const ms = unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
  return clampSnooze(ms);
}
function clampSnooze(ms: number): number {
  return Math.max(SNOOZE_MIN_MS, Math.min(SNOOZE_MAX_MS, Math.round(ms)));
}

// ── Run report ──────────────────────────────────────────────────────────────
// The structured report a run ends with (the cron_report pseudo-tool):
// powers the history line, the delivery decision, the job thread, and the
// next run's context. Absent when the agent never called the tool.
//
// `message` is THE DELIVERABLE — the full report the user reads in the job
// thread. It rides the schema on purpose: asking the model to compose a free-
// text reply AND file a separate verdict is two terminal actions, and tool-
// mode models reliably do exactly one (a live digest job produced no prose in
// 9 of 10 runs). Schema-forced beats prose-hoped. The message is delivered,
// never persisted on job state / the run log — verdictOnly() strips it there.
export interface CronReport {
  status: "ok" | "nothing" | "problem";
  summary: string;
  notify?: boolean;
  message?: string;
}

// The lean verdict (no message body) — what job state and the run log keep;
// the full message lives only in the job thread it was delivered to.
export function verdictOnly(report: CronReport): CronReport {
  return { status: report.status, summary: report.summary, notify: report.notify };
}

// ── Englyph Config ───────────────────────────────────────────────────────────

export interface CronEnglyphConfig {
  storeOutcome?: boolean;
  recallContext?: string;         // query for pre-run context enrichment
  recallIntent?: string;         // companion intents: procedural | preference | reflection | state_check | recall | general
  conditionalQuery?: string;     // Englyph query for conditional execution
  conditionalThreshold?: number; // min results to proceed (default 1)
}

// ── Job State ───────────────────────────────────────────────────────────────

export interface CronJobState {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors: number;
  scheduleErrorCount: number;
  totalRuns: number;
  totalErrors: number;
  lastEnglyphMemoryId?: string;
  // Agent self-pacing (cron_snooze): the next fire is pinned here instead of
  // the schedule's natural slot. Consumed by the run that fires at/after it;
  // for "at" one-shots it also keeps the job enabled past a completed run.
  snoozeUntilMs?: number;
  // The last run's structured verdict — fed into the next run's context.
  lastReport?: CronReport;
}

// ── CronJob ─────────────────────────────────────────────────────────────────

export type CronSessionTarget = "isolated" | "persistent" | `session:${string}`;

// The executor strips "session:" and resolves the residue straight into a
// sessions-dir path — accept only path-safe ids so a REST- or
// prompt-injection-supplied "session:../<otherAgent>/<id>" can't cross the
// per-agent directory. Returns an error string, or null when valid.
export function validateSessionTarget(value: unknown): string | null {
  if (typeof value !== "string") return "sessionTarget must be a string";
  if (value === "isolated" || value === "persistent") return null;
  if (/^session:[A-Za-z0-9_-]{1,128}$/.test(value)) return null;
  return `Invalid sessionTarget "${value}" — use "isolated", "persistent", or "session:<alphanumeric-id>"`;
}

export interface CronJob {
  id: string;
  agentId: string;
  name: string;
  description?: string;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  createdBy: "user" | "agent" | "system";
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;
  payload: CronPayload;
  priority: CronPriority;
  tags?: string[];
  deleteAfterRun?: boolean;
  delivery?: CronDelivery; // absent (legacy rows) = "agent" — see deliveryMode()
  englyph?: CronEnglyphConfig;
  state: CronJobState;
}

// ── Run Log ─────────────────────────────────────────────────────────────────

export interface CronRunLogEntry {
  ts: number;
  jobId: string;
  jobName: string;
  agentId: string;
  status: "ok" | "error" | "skipped";
  error?: string;
  summary?: string;
  sessionId?: string;
  durationMs?: number;
  provider?: string;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  englyphMemoryId?: string;
  triggeredBy?: "schedule" | "manual";
  report?: CronReport;
  // What reached the user: "message" = thread + chat mirror, "notify" =
  // thread + toast, "thread" = the job-thread record only, "none" = nothing.
  delivered?: "message" | "notify" | "thread" | "none";
  snoozedMs?: number;
}

// ── Execution Result ────────────────────────────────────────────────────────

export interface CronRunResult {
  status: "ok" | "error" | "skipped";
  error?: string;
  summary?: string;
  // The run's full deliverable — cron_report.message, falling back to the
  // last composed reply (oc.lastAssistantText). Filed into the job thread
  // and mirrored by a "message" ping. `summary` stays the short verdict for
  // the log / toast / continuity.
  message?: string;
  sessionId?: string;
  durationMs: number;
  provider?: string;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  report?: CronReport; // structured report from cron_report (incl. message)
  snoozeMs?: number; // agent self-pacing from cron_snooze (already clamped)
  delivered?: "message" | "notify" | "thread" | "none";
}

// ── Backoff ─────────────────────────────────────────────────────────────────

export const BACKOFF_SCHEDULE_MS = [
  30_000,     // 30s
  60_000,     // 1m
  300_000,    // 5m
  900_000,    // 15m
  3_600_000,  // 1h
];

export function errorBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, BACKOFF_SCHEDULE_MS.length - 1);
  return idx >= 0 ? BACKOFF_SCHEDULE_MS[idx] : 0;
}

// ── Transient Error Detection ───────────────────────────────────────────────

const TRANSIENT_PATTERNS = [
  /rate_limit/i,
  /overloaded/i,
  /network/i,
  /timeout/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /5\d{2}/,
  /server_error/i,
];

export function isTransientError(error: string): boolean {
  return TRANSIENT_PATTERNS.some((p) => p.test(error));
}
