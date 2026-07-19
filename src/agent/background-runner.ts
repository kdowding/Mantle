import type { MantleConfig } from "../config/schema.js";
import type { ToolRegistry } from "../tools/registry.js";
import { getAgent } from "../config/loader.js";
import { registerAgentActivity } from "./agent-lock.js";
import { enqueueDelivery, drainAgent } from "./delivery-outbox.js";
import { getUserName } from "./prompt-builder.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type BackgroundTaskStatus = "running" | "complete" | "failed" | "aborted";

export interface BackgroundTask {
  id: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  sessionId: string;
  agentId: string;
  summary?: string;
  status: BackgroundTaskStatus;
  startedAt: string;
  completedAt?: string;
  result?: string;
  error?: string;
}

export interface StartParams {
  toolName: string;
  toolArgs: Record<string, unknown>;
  sessionId: string;
  agentId: string;
  summary?: string; // human-readable hint for the agent's delivery turn
}

// ── Runner ──────────────────────────────────────────────────────────────────

export class BackgroundTaskRunner {
  private tasks = new Map<string, BackgroundTask>();
  private config: MantleConfig;
  private registry: ToolRegistry;
  private inFlight = new Set<string>();
  // Per-task abort controllers, so dispose (shutdown) and agent purge
  // (abortAgentLock → the registered activity) can actually CANCEL a long
  // tool mid-flight instead of just relabeling the task while it keeps
  // touching a workspace being deleted underneath it.
  private controllers = new Map<string, AbortController>();
  private disposed = false;

  // localModelManager is no longer needed here — delivery runs through the
  // durable outbox, which carries its own provider deps.
  constructor(config: MantleConfig, registry: ToolRegistry) {
    this.config = config;
    this.registry = registry;
  }

  start(params: StartParams): Promise<{ taskId: string }> {
    if (this.disposed) {
      throw new Error("BackgroundTaskRunner is disposed");
    }
    const id = `bg-${crypto.randomUUID().slice(0, 12)}`;
    const task: BackgroundTask = {
      id,
      toolName: params.toolName,
      toolArgs: params.toolArgs,
      sessionId: params.sessionId,
      agentId: params.agentId,
      summary: params.summary,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.tasks.set(id, task);
    this.inFlight.add(id);

    // Fire and forget — errors are captured onto the task record
    this.execute(task).catch((err) => {
      console.error(`[MANTLE:bg] Unhandled error in task ${id}:`, err);
    });

    console.log(`[MANTLE:bg] Started ${id}: ${params.toolName} (session ${params.sessionId})`);
    return Promise.resolve({ taskId: id });
  }

  stop(): void {
    this.disposed = true;
    // Mark in-flight tasks as aborted AND fire their controllers so the
    // running tools (child processes, fetches, MCP calls) get a real
    // cancellation signal instead of running on into teardown.
    for (const id of this.inFlight) {
      const t = this.tasks.get(id);
      if (t && t.status === "running") {
        t.status = "aborted";
        t.error = "Runner disposed during task";
        t.completedAt = new Date().toISOString();
      }
      this.controllers.get(id)?.abort();
    }
    this.inFlight.clear();
  }

  // ── Private ────────────────────────────────────────────────────────────

  private async execute(task: BackgroundTask): Promise<void> {
    // Per-task cancellation, reachable two ways: runner dispose (shutdown)
    // and agent purge (abortAgentLock fires registered activities — same
    // wiring as sub-agent child loops, subagent-manager.ts).
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    const unregisterActivity = registerAgentActivity(task.agentId, () => controller.abort());
    try {
      // Step 1: run the inner tool. Uses the full registry so nested tool
      // calls (englyph_research invokes englyph_search etc.) still resolve.
      const agent = getAgent(this.config, task.agentId);
      const result = await this.registry.execute(task.toolName, task.toolArgs, {
        agentId: task.agentId,
        sessionId: task.sessionId,
        workspacePath: agent?.workspace,
        signal: controller.signal,
        // No backgroundRunner threaded through to nested tools — we only
        // want top-level async for now, no recursion into more async tasks.
      });

      if (this.disposed) return;
      if (controller.signal.aborted) {
        // Aborted by purge — the agent (and its session) may be mid-delete;
        // don't enqueue a delivery into a vanishing inbox.
        task.status = "aborted";
        task.error = "Task aborted";
        task.completedAt = new Date().toISOString();
        return;
      }

      if (result.isError) {
        task.status = "failed";
        task.error = result.content;
      } else {
        task.status = "complete";
        task.result = result.content;
      }
      task.completedAt = new Date().toISOString();
      console.log(`[MANTLE:bg] ${task.id} ${task.status} (${this.elapsedSeconds(task)}s)`);

      // Step 2: deliver — trigger an agent turn in the target session with
      // a synthetic user message so the agent can respond naturally to the result.
      await this.deliverResult(task);
    } catch (err) {
      task.status = controller.signal.aborted ? "aborted" : "failed";
      task.error = err instanceof Error ? err.message : String(err);
      task.completedAt = new Date().toISOString();
      console.error(`[MANTLE:bg] ${task.id} ${task.status}:`, task.error);
      // Still try to deliver a failure notification — unless aborted
      // (purge/shutdown is tearing the target down).
      if (!controller.signal.aborted && !this.disposed) {
        await this.deliverResult(task).catch((e) => {
          console.error(`[MANTLE:bg] ${task.id} failed to deliver failure notification:`, e);
        });
      }
    } finally {
      unregisterActivity();
      this.controllers.delete(task.id);
      this.inFlight.delete(task.id);
    }
  }

  private elapsedSeconds(task: BackgroundTask): number {
    if (!task.completedAt) return 0;
    return Math.round((new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime()) / 1000);
  }

  private async deliverResult(task: BackgroundTask): Promise<void> {
    // Build the synthetic user message — explicitly labeled so the agent
    // doesn't confuse it with the user's voice — then hand off to the shared
    // delivery front door (lock → append → loop → broadcast → release).
    const user = getUserName();
    const header = [
      `[BACKGROUND TASK ${task.status.toUpperCase()}]`,
      `Task: ${task.id}`,
      `Tool: ${task.toolName}`,
      task.summary ? `Summary: ${task.summary}` : null,
      `Elapsed: ${this.elapsedSeconds(task)}s`,
      "",
      "--- RESULT ---",
    ].filter((s): s is string => s !== null).join("\n");

    const body = task.status === "complete"
      ? (task.result ?? "(empty result)")
      : `Task failed: ${task.error ?? "unknown error"}`;

    const trailer = task.status === "complete"
      ? `\n\n--- END RESULT ---\n\nThis is a system-delivered notification, not a message from ${user}. Respond to ${user} about what you found from the background task. If the conversation pivoted while you were working, acknowledge that and judge whether this result is still relevant.`
      : `\n\n--- END RESULT ---\n\nThis is a system-delivered notification, not a message from ${user}. Let ${user} know the background task failed.`;

    // Durable enqueue + drain — the outbox handles lock-waiting and retry, so
    // a result is no longer dropped when the agent stays busy or restarts.
    enqueueDelivery(
      {
        agentId: task.agentId,
        sessionId: task.sessionId,
        message: `${header}\n\n${body}${trailer}`,
        source: "background",
        toolName: task.toolName,
        taskId: task.id,
        status: task.status,
      },
      { isDisposed: () => this.disposed },
    );
    void drainAgent(task.agentId);
  }
}
