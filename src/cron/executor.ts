import { resolve } from "path";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import type { MantleConfig } from "../config/schema.js";
import { resolveProviderTurn } from "../agent/providers/catalog.js";
import type { LocalModelManager } from "../local/manager.js";
import type { ToolRegistry } from "../tools/registry.js";
import { SessionManager, mutateSessionIndex, readSessionIndex } from "../agent/session.js";
import { coerceThinkingLevel } from "../agent/loop.js";
import { runTriggeredAgentTurn, type PseudoTool } from "../agent/triggered-turn.js";
import { enqueueDelivery, drainAgent } from "../agent/delivery-outbox.js";
import { compactIfNeeded, effectiveCompactionThreshold, resolveContextWindow } from "../agent/compaction.js";
import { withAgentLock } from "../agent/agent-lock.js";
import { getAgent } from "../config/loader.js";
import type { CronJob, CronRunResult, CronReport, CronDeliveryMode } from "./types.js";
import { isTransientError, deliveryMode, parseSnoozeDelay, verdictOnly } from "./types.js";
import { threadSessionId, buildThreadBody, planPing, deliveredStamp } from "./delivery.js";
import { resolveCronContext, resolveCronToolsAllow, cronWorkspaceFilenames } from "./presets.js";
import { buildMemoryPack } from "../agent/memory-pack.js";
import { checkCondition, enrichContext, storeOutcome } from "./englyph-hooks.js";
import type { CronStore } from "./store.js";
import type { CronRunLog } from "./run-log.js";

const MAX_ONESHOT_RETRIES = 3;

// WS broadcast for "notify" deliveries — injected by index.ts (the
// setSyntheticTurnBroadcast idiom; core never imports src/server).
let cronBroadcast: ((msg: Record<string, unknown>) => void) | null = null;
export function setCronBroadcast(fn: (msg: Record<string, unknown>) => void): void {
  cronBroadcast = fn;
}

// (cron_snooze delay parsing lives in types.ts — pure + unit-tested there.)

export async function executeCronJob(
  job: CronJob,
  config: MantleConfig,
  localModelManager: LocalModelManager | undefined,
  registry: ToolRegistry,
  store: CronStore,
  runLog: CronRunLog,
  triggeredBy: "schedule" | "manual" = "schedule",
): Promise<CronRunResult> {
  const agent = getAgent(config, job.agentId);
  if (!agent) {
    return makeErrorResult(`Agent not found: ${job.agentId}`);
  }

  const startTime = Date.now();

  // Mark running FIRST — atomically, BEFORE the englyph pre-hooks. The
  // hooks are network round-trips; marking after them left a window where
  // a manual trigger (which gates on runningAtMs) could double-fire the
  // job and both runs would burn the hooks. applyResult always clears the
  // marker, including on skip/error paths.
  store.markRunning(job.id, startTime);

  // ── Englyph pre-hooks (before acquiring lock) ──────────────────────────
  // Conditional check
  const condition = await checkCondition(job, registry);
  if (!condition.proceed) {
    const result: CronRunResult = {
      status: "skipped",
      error: condition.reason,
      durationMs: Date.now() - startTime,
    };
    await applyResult(job, result, store, runLog, triggeredBy);
    return result;
  }

  // Context enrichment
  const contextPrefix = await enrichContext(job, registry);

  // ── Run under the agent lock (owner "cron" — its own rank) ──────────────
  const locked = await withAgentLock<CronRunResult>(
    job.agentId,
    { owner: "cron", policy: "skip" },
    async (controller) => {
      try {
        // ── Session setup ─────────────────────────────────────────────────
        const baseMantleDir = resolve(config.basePath, ".mantle");
        const sessionsDir = resolve(baseMantleDir, "sessions", job.agentId);

        let sessionId: string;
        if (job.sessionTarget === "isolated") {
          sessionId = `cron-${job.id.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
        } else if (job.sessionTarget === "persistent") {
          sessionId = `cron-${job.id.slice(0, 8)}`;
        } else {
          // session:<custom-id> — create/update validate the shape, but old
          // DB rows predate that; refuse a path-unsafe residue here too
          // rather than resolving it into the sessions tree.
          sessionId = job.sessionTarget.slice("session:".length);
          if (!/^[\w-]{1,128}$/.test(sessionId)) {
            throw new Error(`Unsafe sessionTarget on job ${job.id}: ${job.sessionTarget}`);
          }
        }

        const session = new SessionManager(sessionId, sessionsDir);

        // Register session in index
        mutateSessionIndex(sessionsDir, (index) => {
          if (index.sessions.find((s) => s.id === sessionId)) return false;
          index.sessions.push({
            id: sessionId,
            createdAt: new Date().toISOString(),
            lastMessageAt: new Date().toISOString(),
            title: `[Cron] ${job.name}`,
            provider: "system",
            model: "cron",
            messageCount: 0,
            isCron: true,
          });
        });

        // Compaction for persistent sessions. Resolved here (not in the front
        // door) because compaction needs a live provider before the turn runs;
        // the front door re-resolves identically for the turn itself.
        if (job.sessionTarget !== "isolated") {
          const compactResolved = resolveProviderTurn(config, { localModelManager }, {
            requestedProvider: job.payload.provider,
            requestedModel: job.payload.model,
            agentDefaultProvider: agent.defaultProvider,
            agentDefaultModel: agent.defaultModel,
            globalDefaultProvider: config.defaultProvider,
          });
          if (compactResolved.ok) {
            await compactIfNeeded({
              session,
              provider: compactResolved.provider,
              model: compactResolved.model,
              threshold: effectiveCompactionThreshold(
                resolveContextWindow(compactResolved.provider.name, compactResolved.model, config),
                config,
              ),
            });
          }
        }

        // ── Build message ───────────────────────────────────────────────────
        let userMessage = job.payload.message;
        if (contextPrefix) {
          userMessage = contextPrefix + userMessage;
        }
        // Continuity: the previous run's verdict rides into this one.
        if (job.state.lastReport) {
          const r = job.state.lastReport;
          userMessage = `[Previous run: ${r.status} — ${r.summary}]\n\n${userMessage}`;
        }
        // Steering: the user can reply to a filed report in the job's thread;
        // those replies ride into the next run so the job course-corrects
        // ("less X, more Y") without an edit to the job prompt.
        const steering = await readThreadSteering(config, job);
        if (steering) {
          userMessage = `${steering}\n\n${userMessage}`;
        }

        await session.appendMessage({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          role: "user",
          content: [{ type: "text", text: userMessage }],
        });

        console.log(`[MANTLE:cron] Running "${job.name}" for ${job.agentId}`);

        // ── Pseudo-tools: the run's verdict + self-pacing ────────────────────
        // Trigger-local (the channel_yield pattern): advertised to the model,
        // intercepted before the registry, captured into the run result.
        let report: CronReport | undefined;
        let snoozeMs: number | undefined;
        const pseudoTools: PseudoTool[] = [
          {
            def: {
              name: "cron_report",
              description:
                "End this scheduled run by filing your report. ALWAYS call this exactly once, as your last action. " +
                "The `message` field IS your deliverable — the full report the user reads in this job's thread; " +
                "write it complete (markdown fine), don't point at text elsewhere. Required for status 'ok' and " +
                "'problem'; omit it only for 'nothing'. `summary` is the one-line verdict for the run log and your " +
                "next run's context — not the message. Set notify=true only if the user should be interrupted now.",
              inputSchema: {
                type: "object",
                properties: {
                  status: {
                    type: "string",
                    enum: ["ok", "nothing", "problem"],
                    description: "'ok' = task done, 'nothing' = nothing new or noteworthy, 'problem' = needs attention",
                  },
                  summary: { type: "string", description: "One line — what happened / what was found (log + next-run context)" },
                  message: {
                    type: "string",
                    description:
                      "THE DELIVERABLE — the full report/reply the user reads, filed verbatim into the job's thread. Required for status 'ok'/'problem'; omit for 'nothing'.",
                  },
                  notify: { type: "boolean", description: "Should this interrupt the user right now?" },
                },
                required: ["status", "summary"],
              },
            },
            handle: (input) => {
              const status = input.status === "nothing" || input.status === "problem" ? input.status : "ok";
              const summary = typeof input.summary === "string" ? input.summary.slice(0, 500) : "";
              const message = typeof input.message === "string" && input.message.trim() ? input.message : undefined;
              report = { status, summary, notify: input.notify === true, message };
              // Terminal: the report IS the run's last action. Ending the turn
              // here stops the loop from soliciting one more step the agent has
              // nothing to fill — the empty follow-up that was logged as
              // blank_response (and discarded this very report).
              return { result: "Report recorded.", endTurn: true };
            },
          },
          {
            def: {
              name: "cron_snooze",
              description:
                "Reschedule this job's NEXT run instead of its normal cadence — e.g. nothing actionable yet, check again later. delay: '90s', '30m', '2h', '1d' (clamped 1m–7d). One-shot jobs are re-armed instead of completing.",
              inputSchema: {
                type: "object",
                properties: {
                  delay: { type: "string", description: "e.g. '30m', '2h', '1d'" },
                  reason: { type: "string" },
                },
                required: ["delay"],
              },
            },
            handle: (input) => {
              const ms = parseSnoozeDelay(input.delay);
              if (ms === null) {
                return { result: `Could not parse delay "${String(input.delay)}" — use forms like '30m', '2h', '1d'.`, isError: true };
              }
              snoozeMs = ms;
              return { result: `Next run snoozed ${Math.round(ms / 60000)} minute(s) from now.` };
            },
          },
        ];

        // ── Resolve the run's prompt scope + tool surface from its preset ────
        // Security-first: an unspecified job is "mechanical" — lean context,
        // read+report tools, no exec/write. A stored toolsAllow (privilege
        // containment from the creating turn) still wins over the preset.
        const runCtx = resolveCronContext(job.payload);
        const runToolsAllow = resolveCronToolsAllow(job.payload);
        // Pre-inference memory pack — new for scheduled runs (off unless the
        // preset/job asks). Best-effort + self-budgeted; englyph_* calls bypass
        // the run's tool surface, same as chat's pack.
        let runMemoryPack: string | undefined;
        if (runCtx.memoryPack && registry.has("englyph_search_batch")) {
          runMemoryPack = await buildMemoryPack(registry, job.payload.message, job.agentId, undefined, controller.signal);
        }

        // ── Run the turn via the shared front door ──────────────────────────
        // Cron deliberately omits backgroundRunner from the tool context —
        // scheduled runs are already asynchronous; no further async fan-out.
        const dmode = deliveryMode(job);
        const turn = await runTriggeredAgentTurn({
          config,
          registry,
          deps: { localModelManager },
          agentId: job.agentId,
          session,
          signal: controller.signal,
          providerSelection: {
            requestedProvider: job.payload.provider,
            requestedModel: job.payload.model,
          },
          includeSkills: runCtx.skills,
          promptScope: {
            workspaceFiles: cronWorkspaceFilenames(runCtx.workspaceFiles),
            includeBaseline: runCtx.baseline,
            cronMode: true,
          },
          promptExtras: runMemoryPack ? { memoryPack: runMemoryPack } : undefined,
          toolAllowList: runToolsAllow && runToolsAllow.length > 0 ? [...runToolsAllow] : undefined,
          // Autonomous-run context: no human present. Drives the identity-file
          // write-deny + the bash gate; egressAllowList pins the net-guarded
          // fetch tools to the job's domains (absent = SSRF block only).
          toolContextExtra: {
            autonomous: true,
            ...(job.payload.egressDomains && job.payload.egressDomains.length > 0
              ? { egressAllowList: job.payload.egressDomains }
              : {}),
          },
          pseudoTools,
          composeSystemPrompt: (base) => ({
            ...base,
            // The generic autonomy posture lives in CRON_MODE_PROMPT (stable
            // zone); this names the firing job + the per-delivery nuance: who
            // (if anyone) reads what, and whether that's the reply you write or
            // just the verdict line.
            dynamic:
              base.dynamic +
              `\n\n# This run\nYou are firing as your scheduled job "${job.name}".` +
              cronDeliveryNote(dmode),
          }),
          maxIterations: job.payload.maxIterations ?? 15,
          thinkingLevel: coerceThinkingLevel(job.payload.thinkingLevel),
        });
        if (!turn.ok) {
          throw new Error(turn.error);
        }

        const duration = Date.now() - startTime;
        const oc = turn.outcome;

        // The loop reports stream failures as an outcome, not a throw — so a
        // provider that died mid-turn no longer logs a clean "ok" with a stale
        // summary. A landed limit (graceful summary persisted) counts as ok.
        if (oc.stopCause === "aborted") {
          return {
            status: "skipped",
            error: "Preempted by user chat",
            durationMs: duration,
          } satisfies CronRunResult;
        }
        // A run that filed its verdict (cron_report) did its job — even if the
        // model then emitted a stray turn the loop flagged. cron_report is now
        // terminal so this rarely fires, but it's the safety net: a captured
        // report counts as completion, and report/snooze ride EVERY return
        // path so an odd stop cause can't silently discard the work — or the
        // delivery the user was owed.
        const reported = report !== undefined;
        const succeeded = oc.stopCause === "completed" || oc.landed === true || reported;
        if (!succeeded) {
          return {
            status: "error",
            error: oc.error ?? `Turn ended without completing (${oc.stopCause})`,
            sessionId,
            durationMs: duration,
            provider: turn.backendId,
            model: turn.model,
            report,
            snoozeMs,
          } satisfies CronRunResult;
        }

        console.log(`[MANTLE:cron] Completed "${job.name}" in ${Math.round(duration / 1000)}s (${turn.backendId}/${turn.model}, ${oc.iterations} iter)`);
        return {
          status: "ok",
          // The structured verdict beats a raw text slice as the history line.
          summary: report?.summary ?? (oc.lastAssistantText ? oc.lastAssistantText.slice(0, 500) : undefined),
          // The deliverable: cron_report.message (the schema-forced contract),
          // falling back to the last composed reply for prose-inclined models
          // that wrote the report as text and skipped the field.
          message: report?.message?.trim() || oc.lastAssistantText || undefined,
          sessionId,
          durationMs: duration,
          provider: turn.backendId,
          model: turn.model,
          usage: { input_tokens: oc.usage.inputTokens, output_tokens: oc.usage.outputTokens },
          report,
          snoozeMs,
        } satisfies CronRunResult;
      } catch (err) {
        const duration = Date.now() - startTime;
        const errorMsg = controller.signal.aborted
          ? "Preempted by user chat"
          : (err instanceof Error ? err.message : String(err));
        console.log(`[MANTLE:cron] Error for "${job.name}": ${errorMsg}`);
        return {
          status: controller.signal.aborted ? "skipped" : "error",
          error: errorMsg,
          durationMs: duration,
        } satisfies CronRunResult;
      }
    },
  );

  const result: CronRunResult = locked.ok
    ? locked.value
    : {
        status: "skipped",
        error: "Agent is busy (chat or another job in progress)",
        durationMs: Date.now() - startTime,
      };

  // Delivery — decided before applyResult so the run-log line records it.
  result.delivered = dispatchDelivery(job, result, config);

  // Registry only on success — the Englyph post-hook stores ok outcomes,
  // matching the pre-front-door behavior (errors/skips aren't memorialized).
  await applyResult(job, result, store, runLog, triggeredBy, result.status === "ok" ? registry : undefined);
  return result;
}

// ── Delivery ────────────────────────────────────────────────────────────────
// Two layers (planned by cron/delivery.ts, side-effected here):
//   1. THREAD — every consequential run files its report into the job's own
//      thread session (`cron-thread-<jobId8>`): the durable record the user
//      pulls up in the cron deck and can reply into (steering the next run).
//   2. PING — the delivery mode decides whether the run ALSO interrupts the
//      user now: a chat mirror ("message" / agent-with-notify) or a toast
//      ("notify" / any non-silent error). Errors are never invisible.
function dispatchDelivery(
  job: CronJob,
  result: CronRunResult,
  config: MantleConfig,
): "message" | "notify" | "thread" | "none" {
  const summary = result.report?.summary ?? result.summary ?? "(no summary)";
  const status = result.report?.status ?? result.status;

  // The record. A filing failure is degraded, never silent — the run log
  // stamp stays honest and the user still gets a toast about the run.
  const body = buildThreadBody(result);
  let filed = false;
  if (body) {
    try {
      ensureThreadSession(config, job);
      enqueueDelivery({
        agentId: job.agentId,
        sessionId: threadSessionId(job.id),
        message: body,
        source: "cron",
        toolName: "cron",
        taskId: job.id,
        status,
        verbatim: true,
        provider: result.provider,
        model: result.model,
      });
      filed = true;
    } catch (err) {
      console.warn(`[MANTLE:cron] thread filing failed for "${job.name}": ${err instanceof Error ? err.message : err}`);
      cronBroadcast?.({ type: "cron_notify", agentId: job.agentId, jobId: job.id, jobName: job.name, status: "problem", summary: `Run finished but its report could not be filed: ${summary}` });
    }
  }

  // The knock on the door.
  let ping = planPing(deliveryMode(job), result);
  if (ping === "message") {
    const target = resolveDeliverySession(config, job.agentId);
    if (target && body) {
      // Mirror the report into the user's current chat, verbatim, with the
      // scheduled-run marker so it reads as the job speaking.
      enqueueDelivery({
        agentId: job.agentId,
        sessionId: target,
        message: `*⌁ scheduled · ${job.name}*\n\n${body}`,
        source: "cron",
        toolName: "cron",
        taskId: job.id,
        status,
        verbatim: true,
        provider: result.provider,
        model: result.model,
      });
    } else {
      // No real chat to land in (or nothing to say) — degrade to a toast.
      ping = "notify";
    }
  }
  if (ping === "notify") {
    cronBroadcast?.({ type: "cron_notify", agentId: job.agentId, jobId: job.id, jobName: job.name, status, summary });
  }

  if (filed || ping === "message") {
    void drainAgent(job.agentId); // kick now — an idle agent has no lock release coming
  }
  return deliveredStamp(filed, ping);
}

// Ensure the job's thread session exists (file + index row) so the outbox's
// verbatim delivery can land in it. Also keeps the thread title tracking the
// job name (unless the user hand-renamed it).
function ensureThreadSession(config: MantleConfig, job: CronJob): void {
  const sessionsDir = resolve(config.basePath, ".mantle", "sessions", job.agentId);
  const threadId = threadSessionId(job.id);
  const threadFile = resolve(sessionsDir, `${threadId}.jsonl`);
  if (!existsSync(threadFile)) {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(threadFile, "");
  }
  const title = `⌁ ${job.name}`;
  mutateSessionIndex(sessionsDir, (index) => {
    const existing = index.sessions.find((s) => s.id === threadId);
    if (existing) {
      if (existing.titleEdited || existing.title === title) return false;
      existing.title = title;
      return;
    }
    index.sessions.push({
      id: threadId,
      createdAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      title,
      provider: "system",
      model: "cron-thread",
      messageCount: 0,
      isCron: true,
      cronThreadFor: job.id,
    });
  });
}

// User replies filed into the job's thread since the last run — the steering
// channel. Returns a compact context block, or null when there's nothing new.
// Best-effort: a missing/unreadable thread never blocks a run.
const STEERING_MAX_MESSAGES = 3;
const STEERING_MAX_CHARS = 2000;
async function readThreadSteering(config: MantleConfig, job: CronJob): Promise<string | null> {
  try {
    const sessionsDir = resolve(config.basePath, ".mantle", "sessions", job.agentId);
    const threadId = threadSessionId(job.id);
    if (!existsSync(resolve(sessionsDir, `${threadId}.jsonl`))) return null;
    const since = job.state.lastRunAtMs ?? 0;
    const session = new SessionManager(threadId, sessionsDir);
    const messages = await session.getMessages();
    const replies = messages
      .filter((m) => m.role === "user" && Date.parse(m.timestamp) > since)
      .map((m) =>
        m.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof (b as { text?: unknown }).text === "string")
          .map((b) => b.text.trim())
          .filter(Boolean)
          .join("\n"),
      )
      .filter(Boolean)
      .slice(-STEERING_MAX_MESSAGES);
    if (replies.length === 0) return null;
    let block = replies.map((r) => `- ${r}`).join("\n");
    if (block.length > STEERING_MAX_CHARS) block = `${block.slice(0, STEERING_MAX_CHARS)}…`;
    return `[The user replied in this job's thread since the last run — treat as steering for this run:\n${block}]`;
  } catch {
    return null;
  }
}

// A job giving up is something the user hears about — filed into the job's
// thread (the durable record) AND toasted, regardless of delivery mode.
// Called by the runner's auto-disable paths.
export function announceJobDisabled(job: CronJob, reason: string, config: MantleConfig): void {
  try {
    ensureThreadSession(config, job);
    enqueueDelivery({
      agentId: job.agentId,
      sessionId: threadSessionId(job.id),
      message: `⚠ I've disabled this job — ${reason}. Re-enable it from the cron deck once the cause is fixed.`,
      source: "cron",
      toolName: "cron",
      taskId: job.id,
      status: "problem",
      verbatim: true,
    });
    void drainAgent(job.agentId);
  } catch (err) {
    console.warn(`[MANTLE:cron] disable announcement failed for "${job.name}": ${err instanceof Error ? err.message : err}`);
  }
  cronBroadcast?.({ type: "cron_notify", agentId: job.agentId, jobId: job.id, jobName: job.name, status: "problem", summary: `Disabled: ${reason}` });
}

// The per-run delivery note appended to the dynamic zone: the universal
// contract (message = the deliverable, filed to the thread) lives in the
// cron_report tool description; this adds only the per-mode ping nuance so
// the model knows whether this run also interrupts the user.
function cronDeliveryNote(mode: CronDeliveryMode): string {
  switch (mode) {
    case "message":
      return " Every run of this job also lands in the user's chat: your cron_report message is mirrored there verbatim, so write it as the thing they read.";
    case "agent":
      return " Your cron_report notify flag decides whether this run's message also pings the user's chat now. Reserve notify=true for what genuinely wants attention; the report is in the job's thread either way.";
    case "notify":
      return " The user sees only a brief toast built from your cron_report summary — keep that one line tight. Your full message still files to the job's thread.";
    case "silent":
      return " This run pings no one — your cron_report message files quietly to the job's thread, which the user reads when they choose.";
  }
}

// The user's most recent REAL conversation with this agent (cron/subagent/
// call/assist sessions excluded — a hidden session must never swallow a
// delivery). null = the agent has never been chatted with; the caller
// degrades to a notify toast.
function resolveDeliverySession(config: MantleConfig, agentId: string): string | null {
  try {
    const sessionsDir = resolve(config.basePath, ".mantle", "sessions", agentId);
    const index = readSessionIndex(sessionsDir);
    const real = index.sessions.filter((s) => !s.isCron && !s.isSubagent && !s.isCall && !s.isAssist);
    real.sort(
      (a, b) =>
        Date.parse(b.lastMessageAt ?? b.createdAt ?? "1970") - Date.parse(a.lastMessageAt ?? a.createdAt ?? "1970"),
    );
    return real[0]?.id ?? null;
  } catch {
    return null;
  }
}

// ── Apply Result to Job State ───────────────────────────────────────────────

async function applyResult(
  job: CronJob,
  result: CronRunResult,
  store: CronStore,
  runLog: CronRunLog,
  triggeredBy: "schedule" | "manual",
  registry?: ToolRegistry,
): Promise<void> {
  // Englyph post-hook FIRST — it's a network await, and the state RMW below
  // must be single-tick. The old order read the job, awaited storeOutcome,
  // then wrote the whole stale blob back: anything written to the job
  // during the await (a REST PUT, an enable toggle) was clobbered.
  let englyphMemoryId: string | undefined;
  if (registry && result.status !== "skipped") {
    const forHook = store.getJob(job.id);
    if (!forHook) return; // Job was deleted while running
    const memoryId = await storeOutcome(forHook, result, registry);
    if (memoryId) englyphMemoryId = memoryId;
  }

  // Reload AFTER all awaits, mutate, write — one tick, no interleave.
  const freshJob = store.getJob(job.id);
  if (!freshJob) return; // Job was deleted while running

  const state = freshJob.state;
  state.runningAtMs = undefined;
  // DELIBERATE POLICY: a skipped run (agent busy / conditional miss /
  // preempted) does NOT stamp lastRunAtMs — it never ran. Stamping it
  // drifted the "every" cadence by the skip offset on every collision
  // (next = skipTime + interval instead of the original slot grid).
  // computeNextRunAtMs always advances past `now`, so leaving lastRunAtMs
  // alone re-arms the next natural slot, never a hot retry loop.
  if (result.status !== "skipped") {
    state.lastRunAtMs = Date.now();
  }
  state.lastRunStatus = result.status;
  state.lastError = result.error;
  state.lastDurationMs = result.durationMs;
  if (englyphMemoryId) state.lastEnglyphMemoryId = englyphMemoryId;
  // Lean verdict only — the full message lives in the job thread, not state.
  if (result.report) state.lastReport = verdictOnly(result.report);
  // Snooze is per-run: a run that didn't re-snooze clears any prior pin
  // (the runner's recompute honors a future snoozeUntilMs over the schedule).
  if (result.status !== "skipped") {
    state.snoozeUntilMs = result.snoozeMs ? Date.now() + result.snoozeMs : undefined;
  }

  if (result.status === "error") {
    state.consecutiveErrors++;
    state.totalErrors++;
  } else if (result.status === "ok") {
    state.consecutiveErrors = 0;
  }
  // "skipped" doesn't change consecutive error count

  if (result.status === "ok" || result.status === "error") {
    state.totalRuns++;
  }

  // Handle one-shot jobs
  if (freshJob.schedule.kind === "at") {
    if (result.status === "ok" && result.snoozeMs) {
      // The agent re-armed itself (cron_snooze) — the one-shot lives on and
      // fires again at the pinned time instead of completing.
    } else if (result.status === "ok") {
      if (freshJob.deleteAfterRun) {
        store.removeJob(freshJob.id);
        runLog.append(buildLogEntry(freshJob, result, triggeredBy));
        return;
      }
      freshJob.enabled = false;
    } else if (result.status === "error" && isTransientError(result.error ?? "")) {
      // Retry transient errors for one-shot jobs
      if (state.consecutiveErrors < MAX_ONESHOT_RETRIES) {
        // Keep enabled, backoff will be applied by schedule computation
      } else {
        freshJob.enabled = false;
        state.lastError = `Disabled after ${MAX_ONESHOT_RETRIES} failed attempts: ${result.error}`;
      }
    } else if (result.status === "error") {
      // Permanent error — disable immediately
      freshJob.enabled = false;
    }
  }

  store.updateJob(freshJob);

  // Append run log
  runLog.append(buildLogEntry(freshJob, result, triggeredBy));
}

function buildLogEntry(
  job: CronJob,
  result: CronRunResult,
  triggeredBy: "schedule" | "manual",
): CronRunLogEntry {
  return {
    ts: Date.now(),
    jobId: job.id,
    jobName: job.name,
    agentId: job.agentId,
    status: result.status,
    error: result.error,
    summary: result.summary,
    sessionId: result.sessionId,
    durationMs: result.durationMs,
    provider: result.provider,
    model: result.model,
    usage: result.usage,
    englyphMemoryId: job.state.lastEnglyphMemoryId,
    triggeredBy,
    // Verdict only — a full digest per line would bloat the 2MB log budget.
    report: result.report ? verdictOnly(result.report) : undefined,
    delivered: result.delivered,
    snoozedMs: result.snoozeMs,
  };
}

function makeErrorResult(error: string): CronRunResult {
  return {
    status: "error",
    error,
    durationMs: 0,
  };
}

// Re-export the type for the log entry builder
import type { CronRunLogEntry } from "./types.js";
