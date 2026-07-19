// Gmail native tools — the thin adapter the agent sees. Each pulls the calling
// agent's access token from the broker (keyed by context.agentId; the broker
// refreshes transparently) and calls the engine in api.ts. Stamped
// source:"integration:gmail".

import type { Tool, ToolResult } from "../../tools/types.js";
import type { TokenBroker } from "../types.js";
import * as gmail from "./api.js";

const SOURCE = "integration:gmail";
const INTEGRATION_ID = "gmail";

function fail(message: string): ToolResult {
  return { content: message, isError: true };
}

async function tokenFor(broker: TokenBroker, agentId?: string): Promise<string> {
  if (!agentId) throw new Error("no agent context (context.agentId missing)");
  return broker.getAccessToken(INTEGRATION_ID, agentId);
}

export const GMAIL_WRITE_TOOLS = ["gmail_send_message"];

export function createGmailTools(broker: TokenBroker): Tool[] {
  return [
    {
      name: "gmail_list_messages",
      description:
        "List recent Gmail messages as a compact summary (id, from, subject, date, snippet). Supports Gmail search syntax. Args: query (e.g. 'is:unread from:boss'), limit (1-25, default 10). Use the returned id with gmail_get_message.",
      source: SOURCE,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Gmail search query, e.g. 'is:unread' or 'from:alice newer_than:7d'." },
          limit: { type: "number", description: "Max messages (1-25, default 10)." },
        },
      },
      execute: async (input, ctx): Promise<ToolResult> => {
        try {
          const msgs = await gmail.listMessages(await tokenFor(broker, ctx?.agentId), {
            query: typeof input.query === "string" ? input.query : undefined,
            limit: typeof input.limit === "number" ? input.limit : undefined,
          });
          if (msgs.length === 0) return { content: "No messages found." };
          const lines = msgs.map(
            (m) => `[${m.id}] ${m.subject || "(no subject)"} - from ${m.from || "?"} (${m.date})\n    ${m.snippet}`,
          );
          return { content: `${msgs.length} message(s):\n${lines.join("\n")}` };
        } catch (e) {
          return fail(`gmail_list_messages failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },
    {
      name: "gmail_get_message",
      description: "Read one email's full text by id (ids come from gmail_list_messages). Args: id.",
      source: SOURCE,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Gmail message id." },
        },
        required: ["id"],
      },
      execute: async (input, ctx): Promise<ToolResult> => {
        try {
          const id = String(input.id ?? "");
          if (!id) return fail("id is required.");
          const m = await gmail.getMessage(await tokenFor(broker, ctx?.agentId), id);
          return {
            content: [`From: ${m.from}`, `To: ${m.to}`, `Subject: ${m.subject}`, `Date: ${m.date}`, "", m.body].join("\n"),
          };
        } catch (e) {
          return fail(`gmail_get_message failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },
    {
      name: "gmail_send_message",
      description:
        "Send an email. WRITE action - only available when the connection was granted the send scope. Args: to, subject, body.",
      source: SOURCE,
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address." },
          subject: { type: "string" },
          body: { type: "string", description: "Plain-text body." },
        },
        required: ["to", "subject", "body"],
      },
      execute: async (input, ctx): Promise<ToolResult> => {
        try {
          const to = String(input.to ?? "");
          const subject = String(input.subject ?? "");
          const body = String(input.body ?? "");
          if (!to || !subject) return fail("to and subject are required.");
          const res = await gmail.sendMessage(await tokenFor(broker, ctx?.agentId), to, subject, body);
          return { content: `Sent message ${res.id} to ${to}.` };
        } catch (e) {
          return fail(`gmail_send_message failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },
  ];
}
