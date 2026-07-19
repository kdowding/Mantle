/**
 * Shared OpenAI Chat-Completions layer — message/tool mappers + the streaming
 * event loop that the Grok (api.x.ai) and Local (llama-server) providers both
 * speak, and that a future ChatGPT-API (api.openai.com) provider will reuse.
 *
 * Split of responsibility: each provider builds its OWN request (that's where
 * the real differences live — Grok's `reasoning_effort` gating, local's
 * sampling / tool-curation / chat_template_kwargs / stream_options) and then
 * hands the resulting stream to `streamChatCompletions()`, which is the part
 * that was copy-pasted. The provider's own try/catch wraps the `yield*` so
 * provider-specific error labels (e.g. "Grok API error") are preserved.
 */

import OpenAI from "openai";
import type {
  MessageContent,
  ProviderEvent,
  ProviderMessage,
  ProviderStreamParams,
  StopReason,
  SystemPromptInput,
  TokenUsage,
} from "./types.js";
import { flattenSystemPrompt, extractDynamicZone } from "./provider-utils.js";

type OAIMessage = OpenAI.Chat.ChatCompletionMessageParam;
type OAITool = OpenAI.Chat.ChatCompletionFunctionTool;
type OAIChunk = OpenAI.Chat.Completions.ChatCompletionChunk;

export function mapFinishReason(reason: string | null): StopReason {
  switch (reason) {
    case "stop": return "end_turn";
    case "tool_calls": return "tool_use";
    case "length": return "max_tokens";
    default: return "end_turn";
  }
}

// Mantle's normalized messages → OpenAI Chat-Completions messages. Assistant
// text + tool_use collapse into one message; tool_result blocks become
// separate `tool` role messages; user images ride as image_url parts (injected
// by the attachment resolver). Empty assistant turns are dropped — strict
// OpenAI-compat servers (xAI, llama-server) reject a message with neither
// content nor tool_calls.
export function toOpenAIMessages(messages: ProviderMessage[], systemPrompt: SystemPromptInput): OAIMessage[] {
  // Per-turn dynamic content rides in the latest user message, not the system
  // prompt — keeps the system string + history a stable prefix for the
  // server-side automatic prompt caching (see extractDynamicZone).
  const { system, messages: spliced } = extractDynamicZone(systemPrompt, messages);
  const result: OAIMessage[] = [
    { role: "system", content: flattenSystemPrompt(system) },
  ];

  for (const msg of spliced) {
    if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
        }
      }

      const textContent = textParts.join("\n");
      if (textContent.length === 0 && toolCalls.length === 0) continue;

      const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: textContent.length > 0 ? textContent : null,
      };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      result.push(assistantMsg);
    } else if (msg.role === "user") {
      const toolResults = msg.content.filter(
        (b): b is Extract<MessageContent, { type: "tool_result" }> => b.type === "tool_result",
      );
      const textBlocks = msg.content.filter(
        (b): b is Extract<MessageContent, { type: "text" }> => b.type === "text",
      );
      // image_url blocks are injected by resolveAttachmentsForProvider (non-claude path).
      const imageBlocks = msg.content.filter((b: { type: string }) => b.type === "image_url");

      for (const tr of toolResults) {
        result.push({ role: "tool", tool_call_id: tr.toolUseId, content: tr.content });
      }

      if (textBlocks.length > 0 || imageBlocks.length > 0) {
        if (imageBlocks.length > 0) {
          const parts: unknown[] = [];
          for (const tb of textBlocks) parts.push({ type: "text", text: tb.text });
          for (const ib of imageBlocks) parts.push(ib);
          result.push({ role: "user", content: parts } as OAIMessage);
        } else {
          result.push({ role: "user", content: textBlocks.map((b) => b.text).join("\n") });
        }
      }

      if (toolResults.length === 0 && textBlocks.length === 0 && imageBlocks.length === 0) {
        result.push({ role: "user", content: "" });
      }
    }
  }

  return result;
}

export function toOpenAITools(tools: ProviderStreamParams["tools"]): OAITool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

// Stateful extractor for inline <think>…</think> reasoning. Some llama.cpp
// templates emit chain-of-thought inline in `content` (rather than via
// delta.reasoning_content); this routes the inline spans to the thinking
// channel. Delimiters can split across stream chunks, so a trailing
// partial-delimiter is held back and resolved on the next chunk. Orphan tags
// (a </think> while in text, or <think> while in think) are STRIPPED, not
// leaked — flaky low-quant models sometimes emit stray tags.
export function createThinkSplitter() {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  let mode: "text" | "think" = "text";
  let pending = "";

  function partialSuffixLen(s: string, delim: string): number {
    const max = Math.min(s.length, delim.length - 1);
    for (let k = max; k > 0; k--) {
      if (s.slice(s.length - k) === delim.slice(0, k)) return k;
    }
    return 0;
  }

  function process(delta: string): Array<{ kind: "text" | "think"; text: string }> {
    const out: Array<{ kind: "text" | "think"; text: string }> = [];
    let buf = pending + delta;
    pending = "";
    for (;;) {
      const transition = mode === "text" ? OPEN : CLOSE;
      const orphan = mode === "text" ? CLOSE : OPEN;
      const tIdx = buf.indexOf(transition);
      const oIdx = buf.indexOf(orphan);
      const useTransition = tIdx >= 0 && (oIdx < 0 || tIdx <= oIdx);
      const idx = useTransition ? tIdx : oIdx;
      if (idx >= 0) {
        const seg = buf.slice(0, idx);
        if (seg) out.push({ kind: mode, text: seg });
        buf = buf.slice(idx + (useTransition ? transition.length : orphan.length));
        if (useTransition) mode = mode === "text" ? "think" : "text";
        continue;
      }
      const hold = Math.max(partialSuffixLen(buf, OPEN), partialSuffixLen(buf, CLOSE));
      const emit = hold > 0 ? buf.slice(0, buf.length - hold) : buf;
      if (emit) out.push({ kind: mode, text: emit });
      pending = hold > 0 ? buf.slice(buf.length - hold) : "";
      break;
    }
    return out;
  }

  function flush(): Array<{ kind: "text" | "think"; text: string }> {
    const out: Array<{ kind: "text" | "think"; text: string }> = [];
    if (pending) {
      out.push({ kind: mode, text: pending });
      pending = "";
    }
    return out;
  }

  return { process, flush };
}

export type ThinkSplitter = ReturnType<typeof createThinkSplitter>;

// The shared streaming loop. Translates Chat-Completions chunks into mantle's
// ProviderEvent stream: reasoning_content → thinking; content → text (optionally
// routed through a <think> splitter); tool_calls → start/delta/end; usage +
// llama-server `timings` captured wherever they appear; one message_end emitted
// after the stream drains (usage may trail finish_reason on include_usage).
export async function* streamChatCompletions(
  stream: AsyncIterable<OAIChunk>,
  opts: { splitter?: ThinkSplitter | null } = {},
): AsyncIterable<ProviderEvent> {
  const splitter = opts.splitter ?? null;
  const activeToolCalls = new Map<number, { id: string; name: string; args: string }>();
  let inReasoning = false;
  const endReasoning = function* (): Generator<ProviderEvent> {
    if (inReasoning) {
      inReasoning = false;
      yield { type: "thinking_end" };
    }
  };

  let stopReason: StopReason = "end_turn";
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 0 };

  for await (const chunk of stream) {
    // Usage can arrive on the finish chunk (xAI) or a trailing choice-less
    // chunk (llama-server include_usage) — capture it whenever present.
    if (chunk.usage) {
      const promptTokens = chunk.usage.prompt_tokens ?? 0;
      usage = {
        inputTokens: promptTokens,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        cacheReadTokens:
          (chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } })
            .prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: 0,
        // prompt_tokens already counts cached input, so it IS the full prompt.
        contextTokens: promptTokens,
        tokensPerSec: usage.tokensPerSec,
      };
    }
    // llama-server appends measured speeds on the trailing chunk — the true
    // generation tok/s, more accurate than timing delta arrival client-side.
    const timings = (chunk as { timings?: { predicted_per_second?: number } }).timings;
    if (timings && typeof timings.predicted_per_second === "number") {
      usage.tokensPerSec = timings.predicted_per_second;
    }

    const choice = chunk.choices[0];
    if (!choice) continue;

    const delta = choice.delta as typeof choice.delta & { reasoning_content?: string };

    // Reasoning channel (xAI reasoning models, modern llama.cpp).
    if (delta.reasoning_content) {
      if (!inReasoning) inReasoning = true;
      yield { type: "thinking_delta", text: delta.reasoning_content };
    }

    // Content — possibly carrying inline <think> tags (splitter path).
    if (delta.content) {
      if (splitter) {
        for (const piece of splitter.process(delta.content)) {
          if (piece.kind === "think") {
            if (!inReasoning) inReasoning = true;
            yield { type: "thinking_delta", text: piece.text };
          } else {
            yield* endReasoning();
            yield { type: "text_delta", text: piece.text };
          }
        }
      } else {
        yield* endReasoning();
        yield { type: "text_delta", text: delta.content };
      }
    }

    if (delta.tool_calls) {
      yield* endReasoning();
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        // Some third-party llama.cpp templates split the start across deltas
        // (id in one chunk, function.name in the next). Register on the id
        // and hold the start event until the name lands, instead of silently
        // dropping the whole call.
        if (tc.id && !activeToolCalls.has(idx)) {
          const name = tc.function?.name ?? "";
          activeToolCalls.set(idx, { id: tc.id, name, args: "" });
          if (name) yield { type: "tool_call_start", id: tc.id, name };
        } else if (tc.function?.name) {
          const active = activeToolCalls.get(idx);
          if (active && active.name === "") {
            active.name = tc.function.name;
            yield { type: "tool_call_start", id: active.id, name: active.name };
          }
        }
        if (tc.function?.arguments) {
          const active = activeToolCalls.get(idx);
          if (active) {
            active.args += tc.function.arguments;
            yield { type: "tool_call_delta", id: active.id, args: tc.function.arguments };
          }
        }
      }
    }

    if (choice.finish_reason) {
      if (splitter) {
        for (const piece of splitter.flush()) {
          if (piece.kind === "think") {
            if (!inReasoning) inReasoning = true;
            yield { type: "thinking_delta", text: piece.text };
          } else {
            yield* endReasoning();
            yield { type: "text_delta", text: piece.text };
          }
        }
      }
      yield* endReasoning();
      for (const [, tc] of activeToolCalls) yield { type: "tool_call_end", id: tc.id };
      activeToolCalls.clear();
      stopReason = mapFinishReason(choice.finish_reason);
      // message_end is emitted after the loop — usage may still trail.
    }
  }

  if (inReasoning) yield { type: "thinking_end" };
  yield { type: "message_end", stopReason, usage };
}
