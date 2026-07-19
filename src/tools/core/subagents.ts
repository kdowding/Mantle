// `spawn_agent` — let the model decompose work by spawning a child
// agent loop that runs concurrently with the parent. The child gets a
// fresh session, its own tool surface (parent's by default; optional
// whitelist), and its own iteration budget. When the child finishes,
// its final summary is delivered back to the parent as a single
// system-tagged user message, triggering a fresh parent turn.
//
// This is the primary "give the model a longer attention budget"
// primitive. A parent at depth 0 can spawn up to 4 children at depth
// 1; each of those can spawn up to 4 children at depth 2; depth 2 is
// the cap (the tool refuses to spawn from depth 2). Push-based
// delivery — the parent should NOT poll, should NOT call sleep,
// should NOT call any tool that "waits for" a sub-agent. The result
// arrives autonomously as a `[SUBAGENT_COMPLETE]` user message.
//
// The tool ignores subagentManager being absent for tools called
// outside a chat context (cron tasks don't get one), with
// a clear error message — those flows can use direct tool calls
// instead of spawning.

import type { Tool } from "../types.js";
import { MAX_SUBAGENT_DEPTH, MAX_CONCURRENT_CHILDREN_PER_PARENT } from "../../agent/subagent-manager.js";

export function createSpawnAgentTool(): Tool {
  return {
    name: "spawn_agent",
    description:
      "Spawn a child agent loop that runs concurrently with you, with its own session, tools, and iteration budget. " +
      "Use this to decompose work: research while you keep talking, audit one file while editing another, refactor a " +
      "subsystem in parallel with feature work, or run multiple independent investigations at once.\n\n" +
      "Returns immediately with a task_id and child_session_id. " +
      "**Do not poll**: do not call sessions_list, sessions_history, bash sleep, or any 'check on it' tool after spawning. " +
      "When the child finishes (anywhere from seconds to minutes later), its final summary will arrive in this session as a " +
      "user message tagged `[SUBAGENT_COMPLETE]` — that triggers a fresh turn where you respond naturally to the result. " +
      "While the child runs you can keep talking, spawn more children (up to 4 concurrent per parent), or finish your turn.\n\n" +
      `Constraints: max ${MAX_CONCURRENT_CHILDREN_PER_PARENT} concurrent children per parent session; max depth ${MAX_SUBAGENT_DEPTH} ` +
      "(you cannot spawn from inside a depth-2 sub-agent). The child shares your englyph store and workspace by default.\n\n" +
      "Good fits: 'research X and Y in parallel' (spawn one per topic), 'audit these 5 files for bug Z' (spawn one per file), " +
      "'refactor module M while I keep iterating on the UI'. Bad fits: trivial single-step questions (just answer), tightly " +
      "coupled work that needs your direct hand (do it yourself), anything where you need the answer in the same turn.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "The task description handed to the child agent as its initial user message. Be specific: state the goal, " +
            "the deliverable, and any constraints. The child will pursue this to completion and reply with a final summary. " +
            "Examples: 'Audit src/server/ws.ts for unhandled promise rejections; list each location with a one-line fix sketch.' " +
            "'Research the latest xAI streaming TTS API changes and report what mantle would need to update.'",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional whitelist of tool names the child may use. When omitted, the child inherits your full tool surface " +
            "(except spawn_agent if it would be at the depth cap). Use this to focus a child agent on a narrow task — " +
            "e.g. tools: ['read_file', 'grep_files', 'glob_files'] for a read-only audit child.",
        },
        model: {
          type: "string",
          description:
            "Optional model override. Defaults to the agent's configured default. Use a faster/cheaper model (e.g. haiku) " +
            "for narrow research tasks; use a stronger model for complex reasoning.",
        },
      },
      required: ["task"],
    },
    async execute(input, context) {
      if (!context) {
        return {
          content: "spawn_agent requires agent context (sessionId, agentId) — called outside a live chat loop?",
          isError: true,
        };
      }
      if (!context.subagentManager) {
        return {
          content:
            "spawn_agent is not available in this context. Sub-agent spawning is only enabled for chat sessions; " +
            "background tasks and cron jobs run with a null subagentManager. Use direct tool calls " +
            "(read_file, bash, etc.) instead of decomposition here.",
          isError: true,
        };
      }

      const parentDepth = context.subagentDepth ?? 0;
      if (parentDepth >= MAX_SUBAGENT_DEPTH) {
        return {
          content:
            `You are at sub-agent depth ${parentDepth} (cap: ${MAX_SUBAGENT_DEPTH}). ` +
            `Spawning would create a depth-${parentDepth + 1} child, which is not allowed. ` +
            `Do this work directly using your own tool surface instead of decomposing further.`,
          isError: true,
        };
      }

      const task = typeof input.task === "string" ? input.task.trim() : "";
      if (!task) {
        return {
          content: "spawn_agent requires a non-empty `task` describing what the child should do.",
          isError: true,
        };
      }

      const toolWhitelist = Array.isArray(input.tools)
        ? (input.tools as unknown[]).filter((t): t is string => typeof t === "string")
        : undefined;
      const model = typeof input.model === "string" ? input.model : undefined;

      try {
        const { taskId, childSessionId } = await context.subagentManager.start({
          parentSessionId: context.sessionId,
          parentAgentId: context.agentId,
          parentDepth,
          task,
          toolWhitelist,
          model,
        });

        return {
          content: JSON.stringify({
            task_id: taskId,
            child_session_id: childSessionId,
            depth: parentDepth + 1,
            status: "spawned",
            note:
              `Sub-agent is running in the background. ` +
              `Do not poll — when it completes, you'll receive a user message tagged [SUBAGENT_COMPLETE ${taskId}] ` +
              `with its final summary. You can spawn more sub-agents (up to ${MAX_CONCURRENT_CHILDREN_PER_PARENT} concurrent), ` +
              `keep working on other things, or end your turn.`,
          }),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `Failed to spawn sub-agent: ${message}`,
          isError: true,
        };
      }
    },
  };
}
