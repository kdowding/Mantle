// Sub-agent spawn primitive.
//
// A parent agent loop calls the `spawn_agent` tool, which delegates to
// this manager. The manager:
//   1. Validates depth + per-parent concurrency caps.
//   2. Creates a fresh child session under the same agent, tagged with
//      isSubagent + parentSessionId + subagentDepth so the UI groups
//      it under its parent and the loop knows it's nested.
//   3. Appends the parent-provided task as the child's first user
//      message.
//   4. Fires the child agent loop fire-and-forget — `start()` returns
//      to the parent immediately with a task_id, so the parent can
//      keep working or spawn more siblings while the child runs.
//   5. When the child finishes (end_turn or error), assembles a
//      synthetic `[SUBAGENT_COMPLETE]` message and delivers it to
//      the parent session as a user-role turn. That triggers a fresh
//      parent loop iteration so the parent responds naturally to the
//      child's findings.
//
// The delivery flow is structurally identical to
// BackgroundTaskRunner.deliverResult — same lock acquire pattern, same
// broadcast events, same prompt assembly path. If the two diverge in
// the future, extract a shared `triggerAgentTurn(message)` helper.
//
// Caps and shape decisions:
//   - MAX_SUBAGENT_DEPTH = 2: depth 0 is top-level chat, depth 1 is a
//     direct child, depth 2 is a grandchild. Depth-2 children cannot
//     spawn further (the spawn_agent tool reads context.subagentDepth
//     and refuses). Keeps the spawn graph bounded.
//   - MAX_CONCURRENT_CHILDREN_PER_PARENT = 4: lets a researcher fan
//     out four parallel sub-tasks without saturating. Counted per
//     parent session, not globally — different parents are independent.
//   - Same-agent spawning only in v1: the child runs AS the parent's
//     agent (inherits workspace, persona-less, full tool surface
//     unless caller provides a whitelist). Cross-agent spawn is a
//     v2 feature; would need cross-agent session linking in the UI.

import { resolve } from "path";
import type { MantleConfig } from "../config/schema.js";
import type { LocalModelManager } from "../local/manager.js";
import type { ToolRegistry } from "../tools/registry.js";
import { getAgent } from "../config/loader.js";
import { SessionManager, extractLastAssistantText } from "./session.js";
import { runTriggeredAgentTurn } from "./triggered-turn.js";
import { registerAgentActivity } from "./agent-lock.js";
import { enqueueDelivery, drainAgent } from "./delivery-outbox.js";

// Public caps — exported so the spawn_agent tool's input-validation
// path can mention the exact numbers in its error message.
export const MAX_SUBAGENT_DEPTH = 2;
export const MAX_CONCURRENT_CHILDREN_PER_PARENT = 4;

// Conservative child-loop iteration cap. Generous enough for real
// research / refactor work but tight enough that a runaway child
// doesn't burn $20 of context before its parent notices. The parent's
// own loop has its own (default 100) cap that bounds total work.
const CHILD_MAX_ITERATIONS = 60;

export type SubagentStatus = "running" | "complete" | "failed" | "aborted";

export interface SubagentTask {
  id: string;
  parentSessionId: string;
  parentAgentId: string;
  childSessionId: string;
  childAgentId: string;
  parentDepth: number;
  task: string;
  status: SubagentStatus;
  startedAt: string;
  completedAt?: string;
  result?: string;
  error?: string;
}

export interface StartSubagentParams {
  parentSessionId: string;
  parentAgentId: string;
  parentDepth: number;
  task: string;
  // Optional whitelist restricting the child's tool surface. When
  // omitted, the child inherits the parent's full tool registry. The
  // child can never see `spawn_agent` itself if it's at the depth cap
  // (enforced in the tool, not here).
  toolWhitelist?: string[];
  // Optional model override for the child. Defaults to the agent's
  // configured default model.
  model?: string;
}

export class SubagentManager {
  private tasks = new Map<string, SubagentTask>();
  // Per-parent-session count of active (running) children. Decremented
  // when the child finishes — either successfully, with an error, or
  // aborted. Used for the concurrency cap check at start time.
  private activeChildren = new Map<string, number>();
  // Abort controllers for in-flight child loops, keyed by task id. Lets
  // stop()/dispose actually CANCEL running children instead of only
  // flipping their status — without this the AbortController created in
  // execute() was never fired, so a disposed manager left grandchild loops
  // burning tokens until they finished naturally.
  private abortControllers = new Map<string, AbortController>();
  private disposed = false;

  constructor(
    private config: MantleConfig,
    private registry: ToolRegistry,
    private localModelManager?: LocalModelManager,
  ) {}

  start(params: StartSubagentParams): Promise<{ taskId: string; childSessionId: string }> {
    if (this.disposed) throw new Error("SubagentManager is disposed");

    // Depth check — depth cap is enforced in spawn_agent tool too, but
    // belt-and-suspenders here so direct callers (tests, future SDK
    // users) can't bypass.
    if (params.parentDepth >= MAX_SUBAGENT_DEPTH) {
      throw new Error(
        `Sub-agent depth cap reached (${MAX_SUBAGENT_DEPTH}). A child at depth ${params.parentDepth} cannot spawn further.`,
      );
    }

    // Concurrency check — per parent session, not global.
    const active = this.activeChildren.get(params.parentSessionId) ?? 0;
    if (active >= MAX_CONCURRENT_CHILDREN_PER_PARENT) {
      throw new Error(
        `Parent session ${params.parentSessionId} already has ${active} active sub-agents (cap: ${MAX_CONCURRENT_CHILDREN_PER_PARENT}). Wait for one to finish before spawning more.`,
      );
    }

    const taskId = `sub-${crypto.randomUUID().slice(0, 12)}`;
    const childSessionId = crypto.randomUUID();

    const task: SubagentTask = {
      id: taskId,
      parentSessionId: params.parentSessionId,
      parentAgentId: params.parentAgentId,
      childSessionId,
      childAgentId: params.parentAgentId, // same-agent spawning in v1
      parentDepth: params.parentDepth,
      task: params.task,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, task);
    this.activeChildren.set(params.parentSessionId, active + 1);

    // Fire and forget — error path captures into the task record and
    // still delivers a failure notification to the parent.
    this.execute(task, params).catch((err) => {
      console.error(`[MANTLE:subagent] Unhandled error in ${taskId}:`, err);
    });

    console.log(
      `[MANTLE:subagent] Started ${taskId}: depth ${params.parentDepth}→${params.parentDepth + 1}, ` +
      `parent ${params.parentSessionId.slice(0, 8)}, child ${childSessionId.slice(0, 8)}`,
    );

    return Promise.resolve({ taskId, childSessionId });
  }

  stop(): void {
    this.disposed = true;
    for (const task of this.tasks.values()) {
      if (task.status === "running") {
        // Fire the child loop's abort signal so it actually stops streaming
        // and executing tools, not just flips its status label.
        this.abortControllers.get(task.id)?.abort();
        task.status = "aborted";
        task.error = "Manager disposed during task";
        task.completedAt = new Date().toISOString();
      }
    }
    this.abortControllers.clear();
    this.activeChildren.clear();
  }

  // ── Private ────────────────────────────────────────────────────────────

  private elapsedSeconds(task: SubagentTask): number {
    if (!task.completedAt) return 0;
    return Math.round(
      (new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime()) / 1000,
    );
  }

  private decrementActive(parentSessionId: string): void {
    const c = this.activeChildren.get(parentSessionId) ?? 1;
    if (c <= 1) {
      this.activeChildren.delete(parentSessionId);
    } else {
      this.activeChildren.set(parentSessionId, c - 1);
    }
  }

  private async execute(task: SubagentTask, params: StartSubagentParams): Promise<void> {
    try {
      const agent = getAgent(this.config, task.childAgentId);
      if (!agent) {
        task.status = "failed";
        task.error = `Unknown agent ${task.childAgentId}`;
        task.completedAt = new Date().toISOString();
        await this.deliverResult(task);
        return;
      }

      const baseMantleDir = resolve(this.config.basePath, ".mantle");
      const sessionsDir = resolve(baseMantleDir, "sessions", task.childAgentId);

      // Pre-register the child session's metadata so the UI can pick
      // it up immediately (parent-child grouping renders without
      // waiting for the child's first message to land).
      SessionManager.createSessionMeta(task.childSessionId, sessionsDir, {
        provider: agent.defaultProvider ?? this.config.defaultProvider,
        model: params.model ?? agent.defaultModel ?? "unknown",
        title: task.task.slice(0, 80) + (task.task.length > 80 ? "..." : ""),
        isSubagent: true,
        parentSessionId: task.parentSessionId,
        subagentDepth: task.parentDepth + 1,
        subagentTask: task.task.slice(0, 200),
        subagentTaskId: task.id,
      });

      const childSession = new SessionManager(task.childSessionId, sessionsDir);

      // Seed the child session with the parent's task as a user message.
      // Wrapped with a context header so the child knows it's running
      // as a sub-agent (so it doesn't, e.g., try to spawn other
      // children if the model is at the depth cap).
      const taskHeader = [
        "[SUB-AGENT TASK]",
        `You are running as a sub-agent at depth ${task.parentDepth + 1} of ${MAX_SUBAGENT_DEPTH}.`,
        task.parentDepth + 1 >= MAX_SUBAGENT_DEPTH
          ? "You are at the maximum depth — you cannot spawn further sub-agents."
          : "You can spawn your own sub-agents if needed.",
        "Your final assistant reply will be delivered to your parent agent as a single message.",
        "Make that final reply substantive — summarize what you found, decisions you made, and any open questions.",
        "",
        "--- TASK ---",
        "",
        task.task,
      ].join("\n");

      await childSession.appendMessage({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        role: "user",
        content: [{ type: "text", text: taskHeader }],
      });

      // The child loop deliberately runs WITHOUT the agent lock — its parent
      // still holds it when the child starts (taking it would deadlock).
      // Registering as an agent ACTIVITY keeps it reachable anyway: agent
      // purge / abortAgentLock fire the same controller stop() uses, so a
      // lock-free child can no longer outlive its agent.
      const childAbort = new AbortController();
      this.abortControllers.set(task.id, childAbort);
      const unregisterActivity = registerAgentActivity(task.childAgentId, () => childAbort.abort());
      console.log(`[MANTLE:subagent] ${task.id}: child loop starting (${params.toolWhitelist ? `${params.toolWhitelist.length} whitelisted tools` : "all tools"})`);

      // Full chat prompt — the taskHeader
      // above already tells the model it's a sub-agent. The whitelist (when
      // provided) restricts the tool surface; we do NOT filter spawn_agent
      // out below the depth cap — the tool itself checks depth and refuses.
      let turn;
      try {
        turn = await runTriggeredAgentTurn({
          config: this.config,
          registry: this.registry,
          deps: { localModelManager: this.localModelManager },
          agentId: task.childAgentId,
          session: childSession,
          signal: childAbort.signal,
          providerSelection: { requestedModel: params.model },
          toolAllowList: params.toolWhitelist,
          toolContextExtra: {
            backgroundRunner: undefined, // children don't enqueue background tasks for now
            subagentManager: this,
            subagentDepth: task.parentDepth + 1,
            parentSessionId: task.parentSessionId,
          },
          maxIterations: CHILD_MAX_ITERATIONS,
        });
      } catch (err) {
        task.status = "failed";
        task.error = err instanceof Error ? err.message : String(err);
        task.completedAt = new Date().toISOString();
        console.error(`[MANTLE:subagent] ${task.id} child loop error:`, task.error);
        await this.deliverResult(task);
        return;
      } finally {
        unregisterActivity();
      }

      if (!turn.ok) {
        task.status = "failed";
        task.error = turn.error;
        task.completedAt = new Date().toISOString();
        await this.deliverResult(task);
        return;
      }

      const oc = turn.outcome;
      if (oc.stopCause === "aborted") {
        // Disposed/purged mid-flight. stop() may have stamped the record
        // already; keep its wording if so.
        task.status = "aborted";
        task.error = task.error ?? "Aborted (shutdown, purge, or preemption)";
        task.completedAt = task.completedAt ?? new Date().toISOString();
        await this.deliverResult(task);
        return;
      }
      if (oc.stopCause !== "completed" && oc.landed !== true) {
        // The loop reports stream failures as an outcome, not a throw — a
        // child whose provider died no longer gets delivered as a clean
        // "complete" with a stale (or empty) summary.
        task.status = "failed";
        task.error = oc.error ?? `Child turn ended without completing (${oc.stopCause})`;
        task.completedAt = new Date().toISOString();
        await this.deliverResult(task);
        return;
      }

      // The outcome carries the final assistant text directly; the transcript
      // re-read stays as a fallback for the tool_use-only edge.
      const finalText = oc.lastAssistantText.trim()
        || extractLastAssistantText(await childSession.getMessages()).trim();

      task.status = "complete";
      task.result = finalText || "(child completed with no summary text)";
      task.completedAt = new Date().toISOString();
      console.log(
        `[MANTLE:subagent] ${task.id} complete (${this.elapsedSeconds(task)}s, ${oc.iterations} iter, ${task.result.length} chars)`,
      );

      await this.deliverResult(task);
    } catch (err) {
      task.status = "failed";
      task.error = err instanceof Error ? err.message : String(err);
      task.completedAt = new Date().toISOString();
      console.error(`[MANTLE:subagent] ${task.id} crashed:`, task.error);
      await this.deliverResult(task).catch((e) => {
        console.error(`[MANTLE:subagent] ${task.id} failed to deliver failure:`, e);
      });
    } finally {
      this.abortControllers.delete(task.id);
      this.decrementActive(task.parentSessionId);
    }
  }

  // Deliver the child's result to the parent session as a synthetic
  // user message via the shared front door — appends the message and
  // runs a parent agent turn so the parent responds naturally.
  private async deliverResult(task: SubagentTask): Promise<void> {
    const header = [
      `[SUBAGENT_COMPLETE ${task.status.toUpperCase()}]`,
      `Task: ${task.id}`,
      `Child session: ${task.childSessionId}`,
      `Original ask: ${task.task.slice(0, 200)}${task.task.length > 200 ? "..." : ""}`,
      `Elapsed: ${this.elapsedSeconds(task)}s`,
      "",
      "--- CHILD RESULT ---",
    ].join("\n");

    const body =
      task.status === "complete"
        ? task.result ?? "(empty result)"
        : `Sub-agent failed: ${task.error ?? "unknown error"}`;

    const trailer =
      task.status === "complete"
        ? "\n\n--- END RESULT ---\n\nThis is a system-delivered notification from your sub-agent, not a message from the user. Respond to the user with the relevant findings. If you spawned multiple sub-agents, you may want to wait for the others before composing your response — but a partial update is fine if they want to know progress."
        : "\n\n--- END RESULT ---\n\nThe sub-agent failed. Tell the user what happened and offer to retry or take a different approach.";

    // Enqueue durably, then kick a drain. The outbox owns lock-waiting and
    // retry, so a busy parent (or a restart) no longer drops the child's
    // result. The live subagentManager rides along so a same-process delivery
    // can still spawn; on boot-replay that's absent and spawn degrades to a
    // clean error.
    enqueueDelivery(
      {
        agentId: task.parentAgentId,
        sessionId: task.parentSessionId,
        message: `${header}\n\n${body}${trailer}`,
        source: "subagent",
        toolName: "spawn_agent",
        taskId: task.id,
        status: task.status,
        subagentDepth: task.parentDepth,
      },
      { subagentManager: this, isDisposed: () => this.disposed },
    );
    void drainAgent(task.parentAgentId);
  }
}
