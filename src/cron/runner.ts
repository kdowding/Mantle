import { resolve } from "path";
import { existsSync, mkdirSync } from "fs";
import type { MantleConfig } from "../config/schema.js";
import type { LocalModelManager } from "../local/manager.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { CronJob } from "./types.js";
import { computeNextRunAtMs } from "./schedule.js";
import { CronStore } from "./store.js";
import { CronRunLog } from "./run-log.js";
import { executeCronJob, announceJobDisabled } from "./executor.js";

const MAX_TIMER_MS = 60_000; // Poll at least every 60s
const MIN_REFIRE_GAP_MS = 2_000; // Prevent tight loops
const STARTUP_STAGGER_MS = 5_000; // Stagger catch-up jobs
const MAX_STARTUP_CATCHUP = 5; // Max jobs to catch up on startup

export class CronRunner {
  private config: MantleConfig;
  private localModelManager?: LocalModelManager;
  private registry: ToolRegistry;
  private store: CronStore;
  private runLog: CronRunLog;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastTickMs = 0;

  constructor(
    config: MantleConfig,
    registry: ToolRegistry,
    localModelManager?: LocalModelManager,
  ) {
    this.config = config;
    this.registry = registry;
    this.localModelManager = localModelManager;

    const cronDir = resolve(config.basePath, ".mantle", "cron");
    if (!existsSync(cronDir)) {
      mkdirSync(cronDir, { recursive: true });
    }

    this.store = new CronStore(resolve(cronDir, "cron.db"));
    this.runLog = new CronRunLog(
      resolve(cronDir, "runs"),
      config.cron.runLog.maxBytes,
      config.cron.runLog.keepLines,
    );
  }

  // ── Public API ──────────────────────────────────────────────────────────

  start(): void {
    if (!this.config.cron.enabled) {
      console.log("[MANTLE:cron] Cron system disabled in config");
      return;
    }

    this.running = true;

    // Clear stale running markers from crash recovery
    const cleared = this.store.clearStaleRunning();
    if (cleared > 0) {
      console.log(`[MANTLE:cron] Cleared ${cleared} stale running markers`);
    }

    // Recompute next runs for all enabled jobs
    this.recomputeAllNextRuns();

    // Catch up on missed jobs
    this.catchUpMissedJobs();

    // Arm the timer
    this.armTimer();

    const jobCount = this.store.listJobs({ enabled: true }).length;
    console.log(`[MANTLE:cron] Started (${jobCount} enabled jobs)`);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.store.close();
    console.log("[MANTLE:cron] Stopped");
  }

  // ── Store Access (for API/tool) ───────────────────────────────────────

  getStore(): CronStore {
    return this.store;
  }

  getRunLog(): CronRunLog {
    return this.runLog;
  }

  getStatus(): {
    enabled: boolean;
    jobCount: number;
    enabledCount: number;
    nextWakeAtMs: number | null;
  } {
    const allJobs = this.store.listJobs();
    const enabledJobs = allJobs.filter((j) => j.enabled);
    return {
      enabled: this.config.cron.enabled && this.running,
      jobCount: allJobs.length,
      enabledCount: enabledJobs.length,
      nextWakeAtMs: this.store.getNextWakeMs(),
    };
  }

  // ── Job Management (called by API/tool) ───────────────────────────────

  addJob(job: CronJob): void {
    // Compute initial nextRunAtMs
    job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, {
      createdAtMs: job.createdAtMs,
    }) ?? undefined;

    this.store.addJob(job);
    this.armTimer(); // Re-arm in case this job is due sooner
  }

  updateJob(job: CronJob): void {
    // An explicit edit (schedule change, enable toggle) overrides any agent
    // self-pacing — clear the snooze pin and recompute from the schedule.
    job.state.snoozeUntilMs = undefined;
    job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, {
      lastRunAtMs: job.state.lastRunAtMs,
      consecutiveErrors: job.state.consecutiveErrors,
      createdAtMs: job.createdAtMs,
    }) ?? undefined;

    this.store.updateJob(job);
    this.armTimer();
  }

  removeJob(id: string): boolean {
    const removed = this.store.removeJob(id);
    if (removed) {
      this.runLog.removeJobLog(id);
      this.armTimer();
    }
    return removed;
  }

  async triggerJob(id: string, mode: "due" | "force" = "force"): Promise<{ ran: boolean; reason?: string }> {
    const job = this.store.getJob(id);
    if (!job) return { ran: false, reason: "Job not found" };
    if (!job.enabled && mode === "due") return { ran: false, reason: "Job is disabled" };
    if (job.state.runningAtMs) return { ran: false, reason: "Job is already running" };

    // Fire asynchronously
    executeCronJob(
      job,
      this.config,
      this.localModelManager,
      this.registry,
      this.store,
      this.runLog,
      "manual",
    ).then(() => {
      // Recompute next run after manual execution
      this.recomputeNextRun(job.id);
      this.armTimer();
    }).catch((err) => {
      console.error(`[MANTLE:cron] Manual trigger error for "${job.name}":`, err);
    });

    return { ran: true };
  }

  // ── Timer ─────────────────────────────────────────────────────────────

  private armTimer(): void {
    if (!this.running) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const nextWake = this.store.getNextWakeMs();
    const nowMs = Date.now();
    let delayMs: number;

    if (nextWake === null) {
      // No jobs due — poll every MAX_TIMER_MS
      delayMs = MAX_TIMER_MS;
    } else {
      delayMs = Math.max(nextWake - nowMs, MIN_REFIRE_GAP_MS);
      delayMs = Math.min(delayMs, MAX_TIMER_MS);
    }

    this.timer = setTimeout(() => this.onTick(), delayMs);
  }

  private async onTick(): Promise<void> {
    if (!this.running) return;

    const nowMs = Date.now();

    // Prevent rapid re-fires
    if (nowMs - this.lastTickMs < MIN_REFIRE_GAP_MS) {
      this.armTimer();
      return;
    }
    this.lastTickMs = nowMs;

    try {
      const dueJobs = this.store.getDueJobs(nowMs);

      if (dueJobs.length > 0) {
        console.log(`[MANTLE:cron] ${dueJobs.length} job(s) due`);

        // Group by agent for sequential execution within each agent
        const byAgent = new Map<string, CronJob[]>();
        for (const job of dueJobs) {
          const list = byAgent.get(job.agentId) ?? [];
          list.push(job);
          byAgent.set(job.agentId, list);
        }

        // Run agents concurrently, jobs within each agent sequentially
        const promises = Array.from(byAgent.entries()).map(
          ([agentId, jobs]) => this.runAgentJobs(agentId, jobs),
        );

        await Promise.allSettled(promises);
      }
    } catch (err) {
      console.error("[MANTLE:cron] Tick error:", err);
    }

    // Re-arm for next tick
    this.armTimer();
  }

  private async runAgentJobs(_agentId: string, jobs: CronJob[]): Promise<void> {
    for (const job of jobs) {
      if (!this.running) break;

      try {
        await executeCronJob(
          job,
          this.config,
          this.localModelManager,
          this.registry,
          this.store,
          this.runLog,
          "schedule",
        );
      } catch (err) {
        console.error(`[MANTLE:cron] Execution error for "${job.name}":`, err);
      }

      // Recompute next run
      this.recomputeNextRun(job.id);

      // Check for auto-disable
      this.checkAutoDisable(job.id);
    }
  }

  // ── Schedule Management ───────────────────────────────────────────────

  private recomputeNextRun(jobId: string): void {
    const job = this.store.getJob(jobId);
    if (!job || !job.enabled) return;

    // Agent self-pacing (cron_snooze) pins the next fire — it beats the
    // schedule's natural slot. The pin is per-run: applyResult clears it on
    // every completed run that didn't re-snooze.
    if (job.state.snoozeUntilMs && job.state.snoozeUntilMs > Date.now()) {
      job.state.nextRunAtMs = job.state.snoozeUntilMs;
      job.state.scheduleErrorCount = 0;
      this.store.updateJob(job);
      return;
    }

    const next = computeNextRunAtMs(job.schedule, {
      lastRunAtMs: job.state.lastRunAtMs,
      consecutiveErrors: job.state.consecutiveErrors,
      createdAtMs: job.createdAtMs,
    });

    // A null next for an ENABLED job means the schedule can't be computed
    // (invalid cron expression, unparseable "at") — the job would otherwise
    // go silently dormant forever. Count it so checkAutoDisable's
    // scheduleErrorThreshold branch actually fires; reset on success.
    // "at" is exempt: null after a transient-retry window is its natural
    // end state (applyResult owns disabling one-shots).
    if (next === null && job.schedule.kind !== "at") {
      job.state.scheduleErrorCount++;
      console.warn(
        `[MANTLE:cron] could not compute next run for "${job.name}" (${job.state.scheduleErrorCount}x) — schedule may be invalid`,
      );
    } else if (next !== null) {
      job.state.scheduleErrorCount = 0;
    }

    job.state.nextRunAtMs = next ?? undefined;
    this.store.updateJob(job);
  }

  private recomputeAllNextRuns(): void {
    const jobs = this.store.listJobs({ enabled: true });
    for (const job of jobs) {
      // Only recompute if nextRunAtMs is missing
      if (job.state.nextRunAtMs === undefined) {
        const next = computeNextRunAtMs(job.schedule, {
          lastRunAtMs: job.state.lastRunAtMs,
          consecutiveErrors: job.state.consecutiveErrors,
          createdAtMs: job.createdAtMs,
        });
        job.state.nextRunAtMs = next ?? undefined;
        this.store.updateJob(job);
      }
    }
  }

  private catchUpMissedJobs(): void {
    const nowMs = Date.now();
    const dueJobs = this.store.getDueJobs(nowMs);

    if (dueJobs.length === 0) return;

    const catchUpCount = Math.min(dueJobs.length, MAX_STARTUP_CATCHUP);
    console.log(`[MANTLE:cron] Catching up ${catchUpCount} missed job(s)`);

    // Stagger catch-up execution
    for (let i = 0; i < catchUpCount; i++) {
      const job = dueJobs[i];
      const delay = i * STARTUP_STAGGER_MS;

      setTimeout(() => {
        if (!this.running) return;
        executeCronJob(
          job,
          this.config,
          this.localModelManager,
          this.registry,
          this.store,
          this.runLog,
          "schedule",
        ).then(() => {
          this.recomputeNextRun(job.id);
          this.checkAutoDisable(job.id);
          this.armTimer();
        }).catch((err) => {
          console.error(`[MANTLE:cron] Catch-up error for "${job.name}":`, err);
        });
      }, delay);
    }

    // For remaining missed jobs, just advance their schedules
    for (let i = catchUpCount; i < dueJobs.length; i++) {
      this.recomputeNextRun(dueJobs[i].id);
    }
  }

  private checkAutoDisable(jobId: string): void {
    const job = this.store.getJob(jobId);
    if (!job || !job.enabled) return;

    // Auto-disable after consecutive errors. Announced, never silent — the
    // job files its own obituary in its thread and toasts, so a dead job is
    // something the user HEARS about, not a flag they discover weeks later.
    if (job.state.consecutiveErrors >= this.config.cron.autoDisableAfterErrors) {
      const reason = `${job.state.consecutiveErrors} consecutive failures (last: ${job.state.lastError ?? "unknown"})`;
      job.enabled = false;
      job.state.lastError = `Auto-disabled after ${job.state.consecutiveErrors} consecutive errors: ${job.state.lastError}`;
      this.store.updateJob(job);
      console.log(`[MANTLE:cron] Auto-disabled "${job.name}" after ${job.state.consecutiveErrors} consecutive errors`);
      announceJobDisabled(job, reason, this.config);
    }

    // Auto-disable after schedule computation errors
    if (job.state.scheduleErrorCount >= this.config.cron.scheduleErrorThreshold) {
      job.enabled = false;
      job.state.lastError = `Auto-disabled after ${job.state.scheduleErrorCount} schedule errors`;
      this.store.updateJob(job);
      console.log(`[MANTLE:cron] Auto-disabled "${job.name}" after schedule errors`);
      announceJobDisabled(job, `its schedule failed to compute ${job.state.scheduleErrorCount} times (check the schedule expression)`, this.config);
    }
  }
}
