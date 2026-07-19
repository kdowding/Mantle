import type { CronRunner } from "../cron/runner.js";
import type { CronJob } from "../cron/types.js";
import { validateSessionTarget, validateDeliveryMode } from "../cron/types.js";
import { isCronPresetName, normalizeEgressDomains } from "../cron/presets.js";
import type { MantleConfig } from "../config/schema.js";
import { validateSchedule } from "../cron/schedule.js";
import { getAgent } from "../config/loader.js";

// parseInt that can't poison a query: NaN / negative / non-numeric →
// undefined (caller's default). A raw parseInt here previously let
// `?limit=abc` reach the SQL builder as NaN.
function qsInt(url: URL, name: string): number | undefined {
  if (!url.searchParams.has(name)) return undefined;
  const n = parseInt(url.searchParams.get(name)!, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

export async function handleCronApi(
  req: Request,
  url: URL,
  config: MantleConfig,
  cronRunner: CronRunner,
): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  // GET /api/cron/status
  if (path === "/api/cron/status" && method === "GET") {
    return json(cronRunner.getStatus());
  }

  // GET /api/cron/jobs
  if (path === "/api/cron/jobs" && method === "GET") {
    const agentId = url.searchParams.get("agentId") ?? undefined;
    const enabled = url.searchParams.has("enabled")
      ? url.searchParams.get("enabled") === "true"
      : undefined;
    const tag = url.searchParams.get("tag") ?? undefined;
    const limit = qsInt(url, "limit");
    const offset = qsInt(url, "offset");

    const jobs = cronRunner.getStore().listJobs({ agentId, enabled, tag, limit, offset });
    return json({ jobs });
  }

  // GET /api/cron/jobs/:id
  const jobMatch = path.match(/^\/api\/cron\/jobs\/([\w-]+)$/);
  if (jobMatch && method === "GET") {
    const job = cronRunner.getStore().getJob(jobMatch[1]);
    if (!job) return json({ error: "Job not found" }, 404);
    return json({ job });
  }

  // POST /api/cron/jobs
  if (path === "/api/cron/jobs" && method === "POST") {
    try {
      const body = await req.json();
      return handleCreateJob(body, cronRunner, config);
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
  }

  // PUT /api/cron/jobs/:id
  if (jobMatch && method === "PUT") {
    try {
      const body = await req.json();
      return handleUpdateJob(jobMatch[1], body, cronRunner);
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
  }

  // DELETE /api/cron/jobs/:id
  if (jobMatch && method === "DELETE") {
    const removed = cronRunner.removeJob(jobMatch[1]);
    if (!removed) return json({ error: "Job not found" }, 404);
    return json({ ok: true });
  }

  // POST /api/cron/jobs/:id/run
  const runMatch = path.match(/^\/api\/cron\/jobs\/([\w-]+)\/run$/);
  if (runMatch && method === "POST") {
    const mode = (url.searchParams.get("mode") ?? "force") as "due" | "force";
    const result = await cronRunner.triggerJob(runMatch[1], mode);
    if (!result.ran) return json({ error: result.reason }, 400);
    return json({ ok: true });
  }

  // POST /api/cron/jobs/:id/enable
  const enableMatch = path.match(/^\/api\/cron\/jobs\/([\w-]+)\/enable$/);
  if (enableMatch && method === "POST") {
    const job = cronRunner.getStore().getJob(enableMatch[1]);
    if (!job) return json({ error: "Job not found" }, 404);
    job.enabled = true;
    cronRunner.updateJob(job);
    return json({ ok: true });
  }

  // POST /api/cron/jobs/:id/disable
  const disableMatch = path.match(/^\/api\/cron\/jobs\/([\w-]+)\/disable$/);
  if (disableMatch && method === "POST") {
    const job = cronRunner.getStore().getJob(disableMatch[1]);
    if (!job) return json({ error: "Job not found" }, 404);
    job.enabled = false;
    cronRunner.updateJob(job);
    return json({ ok: true });
  }

  // GET /api/cron/jobs/:id/runs
  const runsMatch = path.match(/^\/api\/cron\/jobs\/([\w-]+)\/runs$/);
  if (runsMatch && method === "GET") {
    const limit = qsInt(url, "limit") ?? 50;
    const offset = qsInt(url, "offset") ?? 0;
    const status = url.searchParams.get("status") ?? undefined;

    const entries = cronRunner.getRunLog().read(runsMatch[1], { limit, offset, status });
    return json({ runs: entries });
  }

  // GET /api/cron/runs
  if (path === "/api/cron/runs" && method === "GET") {
    const agentId = url.searchParams.get("agentId") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;
    const limit = qsInt(url, "limit") ?? 50;
    const offset = qsInt(url, "offset") ?? 0;

    const entries = cronRunner.getRunLog().readAll({ agentId, status, limit, offset });
    return json({ runs: entries });
  }

  return json({ error: "Not found" }, 404);
}

// ── Create Job Handler ──────────────────────────────────────────────────────

function handleCreateJob(body: any, cronRunner: CronRunner, config: MantleConfig): Response {
  // Validate required fields
  if (!body.name) return json({ error: "Missing required field: name" }, 400);
  if (!body.agentId) return json({ error: "Missing required field: agentId" }, 400);
  if (!body.schedule) return json({ error: "Missing required field: schedule" }, 400);
  if (!body.payload?.message) return json({ error: "Missing required field: payload.message" }, 400);

  // A typo'd agentId would mint a job that errors on every run until
  // auto-disable — refuse it at the door instead.
  if (!getAgent(config, String(body.agentId))) {
    return json({ error: `Unknown agent: ${body.agentId}` }, 400);
  }

  // Check job limit
  const count = cronRunner.getStore().countJobsByAgent(body.agentId);
  if (count >= config.cron.maxJobsPerAgent) {
    return json({ error: `Job limit reached (${config.cron.maxJobsPerAgent} max per agent)` }, 400);
  }

  // Validate schedule
  const scheduleError = validateSchedule(body.schedule);
  if (scheduleError) return json({ error: scheduleError }, 400);

  // Validate session target (path-safe — the executor resolves it)
  if (body.sessionTarget !== undefined) {
    const stErr = validateSessionTarget(body.sessionTarget);
    if (stErr) return json({ error: stErr }, 400);
  }

  // Validate delivery contract
  if (body.delivery !== undefined) {
    const dErr = validateDeliveryMode(body.delivery);
    if (dErr) return json({ error: dErr }, 400);
  }

  // Validate preset (security-first: absent resolves to mechanical at run time)
  if (body.payload?.preset !== undefined && !isCronPresetName(body.payload.preset)) {
    return json({ error: `Invalid preset "${String(body.payload.preset)}" — use "mechanical", "aware", or "companion".` }, 400);
  }

  const nowMs = Date.now();
  const job: CronJob = {
    id: crypto.randomUUID(),
    agentId: body.agentId,
    name: body.name,
    description: body.description,
    enabled: body.enabled !== false,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    createdBy: body.createdBy ?? "user",
    schedule: body.schedule,
    sessionTarget: body.sessionTarget ?? config.cron.defaultSessionTarget,
    payload: {
      message: body.payload.message,
      provider: body.payload.provider,
      model: body.payload.model,
      toolsAllow: body.payload.toolsAllow,
      maxIterations: body.payload.maxIterations,
      thinkingLevel: body.payload.thinkingLevel,
      preset: isCronPresetName(body.payload.preset) ? body.payload.preset : undefined,
      egressDomains: normalizeEgressDomains(body.payload.egressDomains),
    },
    priority: body.priority ?? config.cron.defaultPriority,
    tags: body.tags,
    deleteAfterRun: body.deleteAfterRun,
    delivery: body.delivery, // absent = "agent" (deliveryMode default)
    englyph: body.englyph,
    state: {
      consecutiveErrors: 0,
      scheduleErrorCount: 0,
      totalRuns: 0,
      totalErrors: 0,
    },
  };

  cronRunner.addJob(job);
  return json({ job }, 201);
}

// ── Update Job Handler ──────────────────────────────────────────────────────

function handleUpdateJob(id: string, body: any, cronRunner: CronRunner): Response {
  const job = cronRunner.getStore().getJob(id);
  if (!job) return json({ error: "Job not found" }, 404);

  if (body.payload?.preset !== undefined && !isCronPresetName(body.payload.preset)) {
    return json({ error: `Invalid preset "${String(body.payload.preset)}" — use "mechanical", "aware", or "companion".` }, 400);
  }

  // Apply patches
  if (body.name !== undefined) job.name = body.name;
  if (body.description !== undefined) job.description = body.description;
  if (body.enabled !== undefined) job.enabled = body.enabled;
  if (body.schedule !== undefined) {
    const err = validateSchedule(body.schedule);
    if (err) return json({ error: err }, 400);
    job.schedule = body.schedule;
  }
  if (body.sessionTarget !== undefined) {
    const stErr = validateSessionTarget(body.sessionTarget);
    if (stErr) return json({ error: stErr }, 400);
    job.sessionTarget = body.sessionTarget;
  }
  if (body.payload !== undefined) {
    job.payload = { ...job.payload, ...body.payload };
    // Normalize the egress list on the way in (the spread takes it verbatim).
    if (body.payload.egressDomains !== undefined) {
      job.payload.egressDomains = normalizeEgressDomains(body.payload.egressDomains);
    }
  }
  if (body.priority !== undefined) job.priority = body.priority;
  if (body.tags !== undefined) job.tags = body.tags;
  if (body.deleteAfterRun !== undefined) job.deleteAfterRun = body.deleteAfterRun;
  if (body.delivery !== undefined) {
    if (body.delivery === null) {
      job.delivery = undefined; // back to the default ("agent")
    } else {
      const dErr = validateDeliveryMode(body.delivery);
      if (dErr) return json({ error: dErr }, 400);
      job.delivery = body.delivery;
    }
  }
  if (body.englyph !== undefined) {
    job.englyph = body.englyph === null ? undefined : { ...job.englyph, ...body.englyph };
  }

  cronRunner.updateJob(job);
  return json({ job });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
