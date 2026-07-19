import type { Tool } from "../types.js";

// Mantle-side wrapper around englyph's `englyph_research` tool that runs the
// call in a background worker instead of blocking the agent loop. Returns
// immediately with a task_id; when the underlying research completes, the
// BackgroundTaskRunner delivers the result via a synthetic user message
// that triggers a new agent turn in the calling session.
//
// Sync `englyph_research` remains available (bridged from englyph's MCP) for
// cases where blocking is preferable — cron scripts that chain research
// into their next step, or explicit "I'll wait" moments.
// For interactive chat, prefer this async variant so the user can keep talking
// while the research runs.

export function createEnglyphResearchAsyncTool(): Tool {
  return {
    name: "englyph_research_async",
    description:
      "Background-mode wrapper around `englyph_research`. Kicks off a nested " +
      "research session and returns immediately with a task_id — you can keep " +
      "talking to the user while it runs. When the research completes (typically " +
      "1–5 minutes), a new user-role notification will arrive in this session " +
      "starting with `[BACKGROUND TASK COMPLETE]` carrying the result; at that " +
      "point respond to the user naturally about what was found. Use this for any " +
      "research the user casually asks for in chat. Only use the sync " +
      "`englyph_research` when the user explicitly said they'd wait, or in a " +
      "scheduled (cron) context where blocking is fine. Same " +
      "parameters as `englyph_research`.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Free-form research task description. Same semantics as englyph_research.task.",
        },
        wing: {
          type: "string",
          description: "Wing scope for the nested englyph MCP. Same as englyph_research.wing.",
        },
        room: {
          type: "string",
          description: "Optional room scope within the wing.",
        },
        model: {
          type: "string",
          description: "Claude model hint for the nested session (e.g. 'haiku', 'sonnet'). Same as englyph_research.model.",
        },
      },
      required: ["task"],
    },
    async execute(input, context) {
      if (!context) {
        return {
          content: "englyph_research_async requires agent context (sessionId, agentId). Called outside a live chat loop?",
          isError: true,
        };
      }
      if (!context.backgroundRunner) {
        return {
          content: "Background task runner is not available in this context (only chat sessions support async research; use the sync `englyph_research` tool here).",
          isError: true,
        };
      }

      const summary = typeof input.task === "string"
        ? (input.task as string).slice(0, 120)
        : undefined;

      const { taskId } = await context.backgroundRunner.start({
        toolName: "englyph_research",
        toolArgs: input,
        sessionId: context.sessionId,
        agentId: context.agentId,
        summary,
      });

      return {
        content: JSON.stringify({
          task_id: taskId,
          status: "started",
          note: "Research is running in the background. Acknowledge to the user that you've kicked it off; a follow-up message will arrive in this session when it completes.",
        }),
      };
    },
  };
}
