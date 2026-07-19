import type { Tool } from "../types.js";
import type { CronRunner } from "../../cron/runner.js";
import type { MantleConfig } from "../../config/schema.js";
import type { ToolRegistry } from "../registry.js";
import type { CronJob, CronSchedule, CronPriority, CronEnglyphConfig, CronDeliveryMode } from "../../cron/types.js";
import { validateSessionTarget, validateDeliveryMode } from "../../cron/types.js";
import { validateSchedule, describeSchedule } from "../../cron/schedule.js";
import { isCronPresetName, blindEgressDescription, normalizeEgressDomains } from "../../cron/presets.js";
import { analyzeHistory } from "../../cron/englyph-hooks.js";

// The tool is registered ONCE (shared registry), so the acting agent comes
// from the per-call ToolContext — `defaultAgentId` is only the fallback for
// callers that somehow lack one. Without this, every agent's cron_jobs would
// silently operate on the boot-time default agent's jobs.
export function createCronTool(
  cronRunner: CronRunner,
  config: MantleConfig,
  registry: ToolRegistry,
  defaultAgentId: string,
): Tool {
  return {
    name: "cron_jobs",
    description: `Manage scheduled jobs. Create recurring tasks, one-shot timers, or cron-expression schedules that run as background agent sessions.

Actions:
- list: View all your scheduled jobs
- create: Create a new scheduled job
- update: Modify an existing job (partial patch)
- delete: Remove a scheduled job
- run: Manually trigger a job now
- history: View recent execution history for a job
- analyze: Query Englyph for execution patterns and trends

Delivery: every run files its report into the job's own THREAD — a per-job session in the cron deck the user can read and reply into (replies steer the next run). The mode decides whether a run ALSO pings the user now: "agent" (default — the run's cron_report notify flag decides; noteworthy reports mirror into the user's chat), "message" (every report mirrors into the chat), "notify" (a toast), or "silent" (thread only). A reminder the user should SEE wants delivery "message".
Inside a scheduled run, cron_report (its message field is the deliverable the user reads) and cron_snooze (re-check later) are available automatically.`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create", "update", "delete", "run", "history", "analyze"],
          description: "The action to perform",
        },
        // For create/update
        name: {
          type: "string",
          description: "Job name (required for create)",
        },
        description: {
          type: "string",
          description: "Job description",
        },
        schedule_kind: {
          type: "string",
          enum: ["at", "every", "cron"],
          description: "Schedule type: 'at' for one-shot, 'every' for interval, 'cron' for expression",
        },
        schedule_at: {
          type: "string",
          description: "For 'at' schedule: ISO 8601 timestamp or relative duration (e.g., '20m', '1h', '2d')",
        },
        schedule_every_ms: {
          type: "number",
          description: "For 'every' schedule: interval in milliseconds (min 60000 = 1 minute)",
        },
        schedule_cron: {
          type: "string",
          description: "For 'cron' schedule: cron expression (e.g., '*/30 * * * *' for every 30 min)",
        },
        schedule_tz: {
          type: "string",
          description: "Timezone for cron expression (e.g., 'America/New_York')",
        },
        message: {
          type: "string",
          description: "The prompt/message to send to the agent when the job fires (required for create)",
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high", "critical"],
          description: "Execution priority (default: normal)",
        },
        session_target: {
          type: "string",
          description: "Session mode: 'isolated' (new each run), 'persistent' (reuses session), or 'session:<id>' (named)",
        },
        provider: { type: "string", description: "Backend override — composite id like anthropic/api, xai/api, openai/subscription, or local (legacy flat names still accepted)" },
        model: { type: "string", description: "Model override" },
        max_iterations: { type: "number", description: "Max agent loop iterations (default: 15)" },
        preset: {
          type: "string",
          enum: ["mechanical", "aware", "companion"],
          description: "Run context + tool surface (default 'mechanical'). 'mechanical' = lean context + READ/REPORT tools only (the safe crawl-and-report shape; no bash/write/exec). 'aware' = + user profile/memory and light recall, still read-only. 'companion' = full identity (SOUL), memory, and the FULL tool surface — opt in only when the job must act or sound like you. Pick the lightest that does the job.",
        },
        egress_domains: {
          type: "array",
          items: { type: "string" },
          description: "Egress allow-list for this job's web_fetch / attach_url_file — domain suffixes the run may reach (e.g. ['arxiv.org','news.ycombinator.com']; subdomains included). When set, the run CANNOT fetch any other host, so an injected run can't phone home. Strongly recommended for crawl-and-report jobs: list exactly the sites it reads.",
        },
        delivery: {
          type: "string",
          enum: ["agent", "message", "notify", "silent"],
          description: "Where run outcomes land (default 'agent' — the run's cron_report notify flag decides)",
        },
        delete_after_run: { type: "boolean", description: "Auto-delete one-shot jobs after success" },
        tags: { type: "string", description: "Comma-separated tags" },
        englyph_store_outcome: { type: "boolean", description: "Store run results in Englyph memory" },
        englyph_recall_context: { type: "string", description: "Englyph query for pre-run context enrichment" },
        englyph_recall_intent: { type: "string", description: "Intent for recall ranking (procedural/preference/reflection/state_check/recall/general)" },
        englyph_conditional_query: { type: "string", description: "Englyph query for conditional execution" },
        englyph_conditional_threshold: { type: "number", description: "Min Englyph results to proceed" },
        enabled: { type: "boolean", description: "Enable/disable job (for update)" },
        // For update/delete/run/history
        job_id: {
          type: "string",
          description: "Which job to act on (update/delete/run/history). Accepts the full id, the 8-char id prefix shown by `list`, OR the exact job name — you do NOT need the internal UUID. For update, set `name` to RENAME the job.",
        },
        // For history
        limit: { type: "number", description: "Max entries to return (default: 10)" },
        // For analyze
        job_name: { type: "string", description: "Job name to analyze (optional — omit for all jobs)" },
      },
      required: ["action"],
    },
    async execute(input, context) {
      const action = String(input.action);
      const agentId = context?.agentId ?? defaultAgentId;

      switch (action) {
        case "list":
          return handleList(cronRunner, agentId);
        case "create":
          return handleCreate(input, cronRunner, config, agentId, context?.allowedToolNames);
        case "update":
          return handleUpdate(input, cronRunner, agentId);
        case "delete":
          return handleDelete(input, cronRunner, agentId);
        case "run":
          return handleRun(input, cronRunner, agentId);
        case "history":
          return handleHistory(input, cronRunner, agentId);
        case "analyze":
          return handleAnalyze(input, registry, agentId);
        default:
          return { content: `Unknown action: ${action}`, isError: true };
      }
    },
  };
}

// ── Handlers ──────────────────────────────────────────────────────────────

function handleList(cronRunner: CronRunner, agentId: string) {
  const jobs = cronRunner.getStore().listJobs({ agentId });

  if (jobs.length === 0) {
    return { content: "No cron jobs configured." };
  }

  const lines = jobs.map((j) => {
    const status = j.state.runningAtMs ? "running" : (j.enabled ? "idle" : "disabled");
    const lastRun = j.state.lastRunAtMs ? new Date(j.state.lastRunAtMs).toISOString() : "never";
    const errors = j.state.consecutiveErrors > 0 ? ` (${j.state.consecutiveErrors} errors)` : "";
    return `- **${j.name}** [${j.id.slice(0, 8)}] — ${describeSchedule(j.schedule)} | ${status}${errors} | last: ${lastRun}`;
  });

  return { content: lines.join("\n") };
}

function handleCreate(
  input: Record<string, unknown>,
  cronRunner: CronRunner,
  config: MantleConfig,
  agentId: string,
  allowedToolNames?: string[],
) {
  // Validate required fields
  if (!input.name) return { content: "Missing required field: name", isError: true };
  if (!input.message) return { content: "Missing required field: message", isError: true };
  if (!input.schedule_kind) return { content: "Missing required field: schedule_kind", isError: true };

  // Check job limit
  const count = cronRunner.getStore().countJobsByAgent(agentId);
  if (count >= config.cron.maxJobsPerAgent) {
    return { content: `Job limit reached (${config.cron.maxJobsPerAgent} max per agent)`, isError: true };
  }

  // Build schedule
  const schedule = buildSchedule(input);
  if (typeof schedule === "string") {
    return { content: schedule, isError: true };
  }

  // Validate schedule
  const scheduleError = validateSchedule(schedule);
  if (scheduleError) {
    return { content: scheduleError, isError: true };
  }

  // Validate session target (path-safe — the executor resolves it)
  if (input.session_target !== undefined) {
    const stErr = validateSessionTarget(input.session_target);
    if (stErr) return { content: stErr, isError: true };
  }

  // Validate delivery mode
  if (input.delivery !== undefined) {
    const dErr = validateDeliveryMode({ mode: input.delivery });
    if (dErr) return { content: dErr, isError: true };
  }

  // Validate preset
  if (input.preset !== undefined && !isCronPresetName(input.preset)) {
    return { content: `Invalid preset "${String(input.preset)}" — use "mechanical", "aware", or "companion".`, isError: true };
  }

  // Build englyph config
  const englyph = buildEnglyphConfig(input);

  const nowMs = Date.now();
  const job: CronJob = {
    id: crypto.randomUUID(),
    agentId,
    name: String(input.name),
    description: input.description ? String(input.description) : undefined,
    enabled: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    createdBy: "agent",
    schedule,
    sessionTarget: (input.session_target as any) ?? config.cron.defaultSessionTarget,
    payload: {
      message: String(input.message),
      provider: input.provider ? String(input.provider) as any : undefined,
      model: input.model ? String(input.model) : undefined,
      maxIterations: input.max_iterations ? Number(input.max_iterations) : undefined,
      // Privilege containment: a job created BY an agent turn runs with at
      // most the tool surface that turn had. Without this, an injected
      // cron_jobs create from a recall-only context (e.g. a channel sub-turn)
      // would mint a job running bash-on-a-timer with the full registry.
      // REST-created jobs (createdBy:"user") are not constrained here.
      toolsAllow: allowedToolNames ? [...allowedToolNames] : undefined,
      // Run preset (cron/presets.ts) — absent resolves to the mechanical
      // default at execute time. Seeds the run's context + tool surface.
      preset: isCronPresetName(input.preset) ? input.preset : undefined,
      egressDomains: normalizeEgressDomains(input.egress_domains),
    },
    priority: (input.priority as CronPriority) ?? config.cron.defaultPriority,
    tags: input.tags ? String(input.tags).split(",").map((t) => t.trim()) : undefined,
    deleteAfterRun: input.delete_after_run === true,
    delivery: input.delivery !== undefined ? { mode: input.delivery as CronDeliveryMode } : undefined,
    englyph: englyph || undefined,
    state: {
      consecutiveErrors: 0,
      scheduleErrorCount: 0,
      totalRuns: 0,
      totalErrors: 0,
    },
  };

  cronRunner.addJob(job);
  // H6: warn (don't block) when the run can reach blind-egress capabilities the
  // per-job allow-list can't cover — so the agent/user knows the exposure.
  const blind = blindEgressDescription(job.payload);
  const warn = blind
    ? `\n\nHeads up: this job can reach ${blind} — capabilities that can send data where mantle can't monitor (the egress allow-list covers only web_fetch / attach_url_file). Use a leaner preset or set egress_domains if it touches untrusted content.`
    : "";
  return { content: `Created job "${job.name}" [${job.id.slice(0, 8)}] — ${describeSchedule(schedule)}${warn}` };
}

function handleUpdate(input: Record<string, unknown>, cronRunner: CronRunner, agentId: string) {
  // `name` here is the RENAME target, so resolve only from job_id (which itself
  // accepts an id/prefix/name — see resolveJob).
  const found = resolveJob(cronRunner, agentId, String(input.job_id ?? ""));
  if ("error" in found) return { content: found.error, isError: true };
  const job = found;
  if (job.agentId !== agentId) return { content: "Cannot modify another agent's job", isError: true };

  // Apply patches
  if (input.name !== undefined) job.name = String(input.name);
  if (input.description !== undefined) job.description = String(input.description);
  if (input.message !== undefined) job.payload.message = String(input.message);
  if (input.priority !== undefined) job.priority = String(input.priority) as CronPriority;
  if (input.enabled !== undefined) job.enabled = Boolean(input.enabled);
  if (input.session_target !== undefined) {
    const stErr = validateSessionTarget(input.session_target);
    if (stErr) return { content: stErr, isError: true };
    job.sessionTarget = String(input.session_target) as any;
  }
  if (input.provider !== undefined) job.payload.provider = String(input.provider) as any;
  if (input.model !== undefined) job.payload.model = String(input.model);
  if (input.preset !== undefined) {
    if (!isCronPresetName(input.preset)) return { content: `Invalid preset "${String(input.preset)}" — use "mechanical", "aware", or "companion".`, isError: true };
    job.payload.preset = input.preset;
  }
  if (input.egress_domains !== undefined) job.payload.egressDomains = normalizeEgressDomains(input.egress_domains);
  if (input.delete_after_run !== undefined) job.deleteAfterRun = Boolean(input.delete_after_run);
  if (input.tags !== undefined) job.tags = String(input.tags).split(",").map((t) => t.trim());
  if (input.delivery !== undefined) {
    const dErr = validateDeliveryMode({ mode: input.delivery });
    if (dErr) return { content: dErr, isError: true };
    job.delivery = { mode: input.delivery as CronDeliveryMode };
  }

  // Schedule update
  if (input.schedule_kind) {
    const schedule = buildSchedule(input);
    if (typeof schedule === "string") return { content: schedule, isError: true };
    const err = validateSchedule(schedule);
    if (err) return { content: err, isError: true };
    job.schedule = schedule;
  }

  // Englyph config update
  const englyph = buildEnglyphConfig(input);
  if (englyph) {
    job.englyph = { ...job.englyph, ...englyph };
  }

  cronRunner.updateJob(job);
  return { content: `Updated job "${job.name}" [${job.id.slice(0, 8)}]` };
}

function handleDelete(input: Record<string, unknown>, cronRunner: CronRunner, agentId: string) {
  const found = resolveJob(cronRunner, agentId, String(input.job_id ?? input.name ?? ""));
  if ("error" in found) return { content: found.error, isError: true };
  const job = found;
  if (job.agentId !== agentId) return { content: "Cannot delete another agent's job", isError: true };

  cronRunner.removeJob(job.id);
  return { content: `Deleted job "${job.name}" [${job.id.slice(0, 8)}]` };
}

async function handleRun(input: Record<string, unknown>, cronRunner: CronRunner, agentId: string) {
  const found = resolveJob(cronRunner, agentId, String(input.job_id ?? input.name ?? ""));
  if ("error" in found) return { content: found.error, isError: true };
  const job = found;
  if (job.agentId !== agentId) return { content: "Cannot run another agent's job", isError: true };

  const result = await cronRunner.triggerJob(job.id, "force");
  if (!result.ran) {
    return { content: `Could not trigger: ${result.reason}`, isError: true };
  }

  return { content: `Triggered job "${job.name}" — running in background` };
}

function handleHistory(input: Record<string, unknown>, cronRunner: CronRunner, agentId: string) {
  const found = resolveJob(cronRunner, agentId, String(input.job_id ?? input.name ?? ""));
  if ("error" in found) return { content: found.error, isError: true };
  const job = found;
  if (job.agentId !== agentId) return { content: "Cannot view another agent's job history", isError: true };

  const limit = input.limit ? Number(input.limit) : 10;
  const entries = cronRunner.getRunLog().read(job.id, { limit });

  if (entries.length === 0) {
    return { content: `No run history for "${job.name}"` };
  }

  const lines = entries.map((e) => {
    const time = new Date(e.ts).toISOString();
    const dur = e.durationMs ? `${Math.round(e.durationMs / 1000)}s` : "?";
    const delivered = e.delivered && e.delivered !== "none" ? ` → ${e.delivered}` : "";
    const sum = e.report?.summary ?? e.summary;
    const tail = e.error ? ` — ${e.error.slice(0, 100)}` : sum ? ` — ${sum.slice(0, 100)}` : "";
    return `- ${time} | ${e.status}${delivered} | ${dur} | ${e.provider ?? "?"}${tail}`;
  });

  return { content: `## Run history for "${job.name}"\n\n${lines.join("\n")}` };
}

async function handleAnalyze(input: Record<string, unknown>, registry: ToolRegistry, agentId: string) {
  const jobName = input.job_name ? String(input.job_name) : undefined;
  const analysis = await analyzeHistory(jobName, registry, agentId);
  return { content: analysis };
}

// ── Helpers ─────────────────────────────────────────────────────────────

// Resolve the job an agent referred to. Agents almost never have the internal
// UUID (list shows only an 8-char prefix), and the user refers to jobs by NAME
// — so accept, in order: exact id → unique 8-char id-prefix → exact name
// (case-insensitive). Name/prefix matching is scoped to this agent's jobs;
// cross-agent ownership is enforced by the caller after resolution.
function resolveJob(
  cronRunner: CronRunner,
  agentId: string,
  ref: string,
): CronJob | { error: string } {
  const key = ref.trim();
  if (!key) return { error: "Missing job reference — pass job_id (accepts the id, id-prefix, or exact name)." };
  const store = cronRunner.getStore();
  const byId = store.getJob(key);
  if (byId) return byId; // caller checks agentId ownership
  const jobs = store.listJobs({ agentId });
  const byPrefix = jobs.filter((j) => j.id.startsWith(key));
  if (byPrefix.length === 1) return byPrefix[0];
  if (byPrefix.length > 1) return { error: `Ambiguous id prefix "${key}" — matches ${byPrefix.length} jobs; use a longer id.` };
  const byName = jobs.filter((j) => j.name.toLowerCase() === key.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return { error: `More than one job is named "${key}" — use its id instead.` };
  return { error: `Job not found: "${key}". Run cron_jobs list to see your jobs' names + ids.` };
}

function buildSchedule(input: Record<string, unknown>): CronSchedule | string {
  const kind = String(input.schedule_kind);

  switch (kind) {
    case "at": {
      if (!input.schedule_at) return "Missing schedule_at for 'at' schedule";
      return { kind: "at", at: String(input.schedule_at) };
    }
    case "every": {
      if (!input.schedule_every_ms) return "Missing schedule_every_ms for 'every' schedule";
      return { kind: "every", everyMs: Number(input.schedule_every_ms) };
    }
    case "cron": {
      if (!input.schedule_cron) return "Missing schedule_cron for 'cron' schedule";
      return {
        kind: "cron",
        expr: String(input.schedule_cron),
        tz: input.schedule_tz ? String(input.schedule_tz) : undefined,
      };
    }
    default:
      return `Unknown schedule kind: ${kind}`;
  }
}

function buildEnglyphConfig(input: Record<string, unknown>): CronEnglyphConfig | null {
  const config: CronEnglyphConfig = {};
  let hasAny = false;

  if (input.englyph_store_outcome !== undefined) {
    config.storeOutcome = Boolean(input.englyph_store_outcome);
    hasAny = true;
  }
  if (input.englyph_recall_context !== undefined) {
    config.recallContext = String(input.englyph_recall_context);
    hasAny = true;
  }
  if (input.englyph_recall_intent !== undefined) {
    config.recallIntent = String(input.englyph_recall_intent);
    hasAny = true;
  }
  if (input.englyph_conditional_query !== undefined) {
    config.conditionalQuery = String(input.englyph_conditional_query);
    hasAny = true;
  }
  if (input.englyph_conditional_threshold !== undefined) {
    config.conditionalThreshold = Number(input.englyph_conditional_threshold);
    hasAny = true;
  }

  return hasAny ? config : null;
}
