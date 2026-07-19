/**
 * Shared OpenAI Responses-API layer — the streaming event loop + tool mapper
 * that the OpenAI Codex (chatgpt.com) and Grok Build (cli-chat-proxy.grok.com)
 * providers both speak. Both proxies report `api_backend: "responses"` and emit
 * the identical event vocabulary; the ~100-line loop was copy-pasted between
 * them.
 *
 * As with the chat layer, request-building stays per-provider (that's where the
 * real differences live: Codex puts the system prompt in top-level
 * `instructions` with nested input_text/output_text content; Grok Build uses a
 * {role:"system"} input item with plain-string content + an encrypted-reasoning
 * include). Each provider builds its request, creates the stream, and hands it
 * here. `errorLabel` keeps the in-stream `response.failed` message branded.
 */

import type { ResponseStreamEvent, Tool } from "openai/resources/responses/responses";
import type { ProviderErrorKind, ProviderEvent, ProviderStreamParams, StopReason } from "./types.js";

// Both subscription proxies emit this vendor extension; it is intentionally
// absent from the public OpenAI Responses event union.
type ProxyResponseStreamEvent = ResponseStreamEvent | {
  type: "response.reasoning.delta";
  delta?: string;
};

// In-stream failures carry a string `code` rather than an HTTP status —
// map the recognizable ones, default to "server" (the request itself was
// accepted; the failure happened provider-side).
function kindFromCode(code: unknown): ProviderErrorKind {
  const c = String(code ?? "").toLowerCase();
  if (c.includes("rate_limit")) return "rate_limit";
  if (c.includes("auth") || c.includes("unauthorized") || c.includes("forbidden")) return "auth";
  if (c.includes("invalid") || c.includes("bad_request")) return "bad_request";
  return "server";
}

// Flat function-tool shape — {type:"function", name, description, parameters} —
// the Responses API shape (NOT the Chat Completions nested {function:{...}}).
export function toResponsesTools(tools: ProviderStreamParams["tools"]): Tool[] {
  return tools.map(
    (t) =>
      ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
        strict: false,
      }) as Tool,
  );
}

// Translate Responses-API SSE events → mantle's ProviderEvent stream. Keys off
// the item id from output_item.added so a function_call (id_call_*) is never
// confused with a parallel reasoning item (id_rs_*). Reasoning spans close on
// the parent output_item.done (exactly one per reasoning item) rather than the
// per-part summary .done events, which would otherwise produce duplicate
// thinking blocks in the UI.
export async function* streamResponsesEvents(
  stream: AsyncIterable<ProxyResponseStreamEvent>,
  opts: { errorLabel: string },
): AsyncIterable<ProviderEvent> {
  const itemMeta = new Map<
    string,
    { type: "function_call" | "reasoning" | "message"; callId?: string; name?: string }
  >();
  let sawToolCall = false;
  let inReasoning = false;
  let stopReason: StopReason = "end_turn";
  let finalUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 0 };

  const usageFrom = (usage: Record<string, unknown> | undefined) => {
    const cachedTokens =
      ((usage?.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens as
        | number
        | undefined) ?? 0;
    const inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
    return {
      inputTokens,
      outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : 0,
      cacheReadTokens: cachedTokens,
      cacheWriteTokens: 0,
      // Responses-API input_tokens is the whole prompt (cached included).
      contextTokens: inputTokens,
    };
  };

  for await (const event of stream) {
    switch (event.type) {
      case "response.output_item.added": {
        const item = event.item as unknown as Record<string, unknown>;
        const itemId = String(item.id ?? "");
        const itemType = String(item.type ?? "");
        if (itemType === "function_call") {
          const callId = String(item.call_id ?? itemId);
          const name = String(item.name ?? "unknown");
          itemMeta.set(itemId, { type: "function_call", callId, name });
          sawToolCall = true;
          yield { type: "tool_call_start", id: callId, name };
        } else if (itemType === "reasoning") {
          // Track but don't emit — a reasoning item is created even at
          // effort none (empty span); real content arrives via the deltas.
          itemMeta.set(itemId, { type: "reasoning" });
        } else if (itemType === "message") {
          itemMeta.set(itemId, { type: "message" });
        }
        break;
      }

      case "response.output_text.delta": {
        if (inReasoning) {
          yield { type: "thinking_end" };
          inReasoning = false;
        }
        yield { type: "text_delta", text: event.delta };
        break;
      }

      case "response.function_call_arguments.delta": {
        const meta = itemMeta.get(event.item_id);
        const callId = meta?.callId ?? event.item_id;
        yield { type: "tool_call_delta", id: callId, args: event.delta };
        break;
      }

      case "response.reasoning.delta":
      case "response.reasoning_summary_text.delta": {
        const delta = (event as { delta?: string }).delta ?? "";
        if (delta) {
          if (!inReasoning) inReasoning = true;
          yield { type: "thinking_delta", text: delta };
        }
        break;
      }

      case "response.output_item.done": {
        const item = event.item as unknown as Record<string, unknown>;
        const itemId = String(item.id ?? "");
        const meta = itemMeta.get(itemId);
        if (meta?.type === "function_call" && meta.callId) {
          yield { type: "tool_call_end", id: meta.callId };
        } else if (meta?.type === "reasoning" && inReasoning) {
          yield { type: "thinking_end" };
          inReasoning = false;
        }
        itemMeta.delete(itemId);
        break;
      }

      case "response.completed": {
        finalUsage = usageFrom(event.response.usage as Record<string, unknown> | undefined);
        stopReason = sawToolCall ? "tool_use" : "end_turn";
        break;
      }

      case "response.incomplete": {
        const reason = (event.response.incomplete_details as Record<string, unknown> | undefined)
          ?.reason;
        stopReason = reason === "max_output_tokens" ? "max_tokens" : "end_turn";
        finalUsage = usageFrom(event.response.usage as Record<string, unknown> | undefined);
        break;
      }

      case "response.failed": {
        const errObj = event.response.error as unknown as Record<string, unknown> | undefined;
        const errMsg = errObj?.message ?? "response.failed";
        yield { type: "error", error: `${opts.errorLabel} error: ${errMsg}`, kind: kindFromCode(errObj?.code) };
        return;
      }

      // Top-level error SSE event (distinct from response.failed) — without
      // this case a mid-stream Codex/Grok-Build failure drained silently and
      // surfaced as a clean (empty) completion.
      case "error": {
        const errEvent = event as unknown as { message?: string; code?: string };
        const errMsg = errEvent.message ?? errEvent.code ?? "stream error";
        yield { type: "error", error: `${opts.errorLabel} error: ${errMsg}`, kind: kindFromCode(errEvent.code) };
        return;
      }

      // Other event types (response.created, response.in_progress,
      // response.content_part.*, response.output_text.done, response.queued, …)
      // carry no normalized signal mantle needs — let them pass.
    }
  }

  // Flush any still-open reasoning before message_end (defensive).
  if (inReasoning) yield { type: "thinking_end" };
  yield { type: "message_end", stopReason, usage: finalUsage };
}
