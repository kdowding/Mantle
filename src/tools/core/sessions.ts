import { resolve } from "path";
import { existsSync, statSync, writeFileSync } from "fs";
import type { Tool } from "../types.js";
import type { MantleConfig } from "../../config/schema.js";
import { SessionManager, type SessionMessage } from "../../agent/session.js";

// Agent-supplied session ids feed straight into resolve(sessionsDir,
// `${id}.jsonl`) — same charset constraint as the REST layer ([\w-]+) so a
// "../<otherAgent>/<id>" can't hop the per-agent directory pin (read AND
// the .md sibling write in render_session_markdown).
const SAFE_SESSION_ID = /^[\w-]+$/;

function rejectUnsafeSessionId(sessionId: string): { content: string; isError: true } | null {
  if (SAFE_SESSION_ID.test(sessionId)) return null;
  return {
    content: JSON.stringify({ error: `Invalid session id: ${sessionId}` }),
    isError: true,
  };
}

export function createSessionTools(config: MantleConfig): Tool[] {
  return [
    createSessionsListTool(config),
    createSessionsHistoryTool(config),
    createRenderSessionMarkdownTool(config),
  ];
}

function createSessionsListTool(config: MantleConfig): Tool {
  return {
    name: "sessions_list",
    description: `List your own chat sessions. Returns session metadata: id, title, timestamps, message count, and provider. Useful for finding recent conversations to review or reference.`,
    inputSchema: {
      type: "object",
      properties: {},
    },
    async execute(_input, context) {
      // Always scope to the calling agent — an agent may only read its own
      // sessions (cross-agent transcript reads were a prompt-injection exfil
      // path). Falls back to the default agent only when no context is wired
      // (e.g. a CLI/test caller).
      const agentId = context?.agentId ?? config.defaultAgent;
      const agent = config.agents.find((a) => a.id === agentId);
      if (!agent) {
        return { content: JSON.stringify({ error: `Unknown agent: ${agentId}` }), isError: true };
      }

      const sessionsDir = resolve(config.basePath, ".mantle", "sessions", agentId);
      const index = SessionManager.loadIndex(sessionsDir);

      // Sort by most recent first
      const sessions = index.sessions
        .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime())
        .map((s) => ({
          id: s.id,
          title: s.title,
          createdAt: s.createdAt,
          lastMessageAt: s.lastMessageAt,
          messageCount: s.messageCount,
          provider: s.provider,
          persona: s.persona ?? null,
        }));

      return { content: JSON.stringify({ agentId, sessions }) };
    },
  };
}

function createSessionsHistoryTool(config: MantleConfig): Tool {
  return {
    name: "sessions_history",
    description: `Read the transcript of a specific session. Returns messages with role, text content, and timestamp. Tool call details are stripped for readability. Use this to review past conversations, extract important information, or understand context from previous sessions.`,
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The session ID to read. Get IDs from sessions_list.",
        },
        limit: {
          type: "number",
          description: "Maximum number of messages to return (default: 50, max: 200).",
        },
      },
      required: ["sessionId"],
    },
    async execute(input, context) {
      const sessionId = String(input.sessionId);
      const invalid = rejectUnsafeSessionId(sessionId);
      if (invalid) return invalid;
      const limit = Math.min(Number(input.limit ?? 50), 200);

      // Scope strictly to the calling agent's own session directory — never
      // search across agents (that leaked other agents' private transcripts).
      const agentId = context?.agentId ?? config.defaultAgent;
      const sessionsDir = resolve(config.basePath, ".mantle", "sessions", agentId);
      const session = new SessionManager(sessionId, sessionsDir);
      const messages = await session.getMessages();

      if (messages.length === 0) {
        return { content: JSON.stringify({ error: `Session not found: ${sessionId}` }), isError: true };
      }

      // Take the last N messages
      const recent = messages.slice(-limit);

      const transcript = recent.map((msg) => {
        // Extract text content only, skip tool calls
        const textParts = msg.content
          .filter((b) => b.type === "text")
          .map((b) => {
            const text = (b as { type: "text"; text: string }).text;
            // Truncate very long messages
            return text.length > 4000 ? text.slice(0, 4000) + "...[truncated]" : text;
          });

        return {
          role: msg.role,
          content: textParts.join("\n"),
          timestamp: msg.timestamp,
        };
      }).filter((m) => m.content); // Skip empty messages (tool-only turns)

      return { content: JSON.stringify({ sessionId, agentId, messages: transcript }) };
    },
  };
}

// ── render_session_markdown ────────────────────────────────────────────────
//
// Converts a session's JSONL transcript into a sibling `.md` file formatted
// for ingestion as Englyph source content. Each turn becomes an H2 section,
// which aligns with englyph's markdown chunker boundaries — one retrievable
// chunk per turn.
//
// Idempotent: if the .md is newer than the .jsonl, returns unchanged. If the
// .jsonl has grown or changed, re-renders from scratch.

function formatTurn(msg: SessionMessage): string {
  const lines: string[] = [`## ${msg.role} — ${msg.timestamp}`, ""];
  let hasContent = false;

  for (const block of msg.content) {
    if (block.type === "text") {
      const text = (block as { type: "text"; text: string }).text;
      if (text.trim()) {
        lines.push(text);
        lines.push("");
        hasContent = true;
      }
    } else if (block.type === "thinking") {
      const text = (block as { type: "thinking"; text: string }).text;
      if (text.trim()) {
        lines.push(`<thinking>`);
        lines.push(text);
        lines.push(`</thinking>`);
        lines.push("");
        hasContent = true;
      }
    } else if (block.type === "tool_use") {
      const tu = block as { type: "tool_use"; name: string; input: Record<string, unknown> };
      let inputJson = "";
      try { inputJson = JSON.stringify(tu.input); } catch { inputJson = "<unserializable>"; }
      if (inputJson.length > 500) inputJson = inputJson.slice(0, 500) + "…";
      lines.push(`**tool:** \`${tu.name}\` — \`${inputJson}\``);
      lines.push("");
      hasContent = true;
    } else if (block.type === "tool_result") {
      const tr = block as { type: "tool_result"; content: string; isError?: boolean };
      let content = tr.content ?? "";
      if (content.length > 1000) content = content.slice(0, 1000) + "…[truncated]";
      const label = tr.isError ? "**tool error:**" : "**tool result:**";
      lines.push(label);
      if (content.trim()) lines.push(content);
      lines.push("");
      hasContent = true;
    }
  }

  return hasContent ? lines.join("\n") : "";
}

function createRenderSessionMarkdownTool(config: MantleConfig): Tool {
  return {
    name: "render_session_markdown",
    description:
      "Render a session's JSONL transcript into a sibling `.md` file formatted " +
      "for Englyph source ingestion. Each turn becomes an H2 section (one retrievable " +
      "chunk per turn under englyph's markdown chunker). Idempotent — if the .md is " +
      "newer than the .jsonl, it's left untouched. Returns the absolute path of the " +
      "rendered markdown file. Use this before `englyph_ingest_source` when adding a " +
      "session to the source pool.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Session ID to render. Must be one of your own sessions in .mantle/sessions/<agent>/.",
        },
        force: {
          type: "boolean",
          description: "Re-render even if .md is newer than .jsonl. Default false.",
        },
      },
      required: ["sessionId"],
    },
    async execute(input, context) {
      const sessionId = String(input.sessionId);
      const invalid = rejectUnsafeSessionId(sessionId);
      if (invalid) return invalid;
      // Pin to the calling agent — only your own sessions are renderable.
      const agentId = context?.agentId ?? config.defaultAgent;
      const force = Boolean(input.force ?? false);

      const agent = config.agents.find((a) => a.id === agentId);
      if (!agent) {
        return { content: JSON.stringify({ error: `Unknown agent: ${agentId}` }), isError: true };
      }

      const sessionsDir = resolve(config.basePath, ".mantle", "sessions", agentId);
      const jsonlPath = resolve(sessionsDir, `${sessionId}.jsonl`);
      const mdPath = resolve(sessionsDir, `${sessionId}.md`);

      if (!existsSync(jsonlPath)) {
        return { content: JSON.stringify({ error: `Session not found: ${sessionId}` }), isError: true };
      }

      // Idempotency: skip if .md is newer than .jsonl
      if (!force && existsSync(mdPath)) {
        const jsonlMtime = statSync(jsonlPath).mtimeMs;
        const mdMtime = statSync(mdPath).mtimeMs;
        if (mdMtime >= jsonlMtime) {
          return { content: JSON.stringify({ path: mdPath, status: "unchanged" }) };
        }
      }

      const session = new SessionManager(sessionId, sessionsDir);
      const messages = await session.getMessages();

      const header = [
        `# Session: ${sessionId}`,
        "",
        `Agent: ${agentId}`,
        `Turns: ${messages.length}`,
        "",
        "---",
        "",
      ];

      const turns = messages.map(formatTurn).filter((s) => s.length > 0);
      const body = turns.join("\n---\n\n");
      writeFileSync(mdPath, header.join("\n") + body, "utf-8");

      return { content: JSON.stringify({ path: mdPath, status: "rendered", turns: messages.length }) };
    },
  };
}
