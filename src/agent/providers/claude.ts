import Anthropic from "@anthropic-ai/sdk";
import type {
  Provider,
  ProviderEvent,
  ProviderStreamParams,
  ProviderMessage,
  StopReason,
  SystemPromptInput,
} from "./types.js";
import { extractDynamicZone, rethrowIfAborted, classifyProviderError } from "./provider-utils.js";

type AnthropicMessage = Anthropic.MessageParam;
type AnthropicContent = Anthropic.ContentBlockParam;
type AnthropicTool = Anthropic.Tool;
type AnthropicSystem = string | Array<Anthropic.TextBlockParam>;

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "end_turn": return "end_turn";
    case "tool_use": return "tool_use";
    case "max_tokens": return "max_tokens";
    default: return "end_turn";
  }
}

// Claude reasoning controls on the GA surface: Opus 4.5+, Sonnet 4.6+, and
// Fable/Mythos take adaptive thinking + `output_config.effort`; the legacy
// `thinking:{type:"enabled",budget_tokens}` path 400s on Opus 4.7+. Haiku and
// older Sonnet 400 on `effort`, so they keep the budget path. claudeTakesEffort
// picks the lane; clampClaudeEffort steps the requested level down to what the
// model accepts (max = Opus 4.6+/Sonnet 4.6+/Fable; xhigh = Opus 4.7+/Fable).
// The UI mirrors these caps in inference.ts effortLevelsFor — this clamp is the
// authoritative server-side guard so cron/assist/API callers can't 400 either.
function claudeTakesEffort(model: string): boolean {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return false;
  if (m.includes("fable") || m.includes("mythos")) return true;
  const opus = m.match(/opus-4-(\d+)/);
  if (opus) return Number(opus[1]) >= 5;
  const sonnet = m.match(/sonnet-4-(\d+)/);
  if (sonnet) return Number(sonnet[1]) >= 6;
  return false; // unknown → legacy budget path (effort might 400)
}

function clampClaudeEffort(
  model: string,
  level: "low" | "medium" | "high" | "xhigh" | "max",
): "low" | "medium" | "high" | "xhigh" | "max" {
  const m = model.toLowerCase();
  const fable = m.includes("fable") || m.includes("mythos");
  const opusN = Number(m.match(/opus-4-(\d+)/)?.[1] ?? 0);
  const sonnetN = Number(m.match(/sonnet-4-(\d+)/)?.[1] ?? 0);
  const hasMax = fable || opusN >= 6 || sonnetN >= 6;
  const hasXhigh = fable || opusN >= 7;
  if (level === "max" && !hasMax) return hasXhigh ? "xhigh" : "high";
  if (level === "xhigh" && !hasXhigh) return "high";
  return level;
}

// Convert our normalized messages to Anthropic's format
function toAnthropicMessages(messages: ProviderMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    const content: AnthropicContent[] = [];

    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          content.push({ type: "text", text: block.text });
          break;
        case "tool_use":
          content.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
          });
          break;
        case "tool_result":
          // Anthropic expects tool_result blocks in user messages
          content.push({
            type: "tool_result",
            tool_use_id: block.toolUseId,
            content: block.content,
            is_error: block.isError ?? false,
          });
          break;
        case "thinking":
          // Never send mantle's internal thinking shape over the wire — the
          // API expects {thinking, signature} and rejects unsigned blocks.
          // The session layer strips thinking on replay anyway; this guards
          // any future path that doesn't.
          break;
        default:
          // Pass through provider-native blocks (image, document) from attachment resolver
          content.push(block as any);
          break;
      }
    }

    result.push({ role: msg.role, content });
  }

  return result;
}

// Convert our tool definitions to Anthropic's format, marking the final tool
// with cache_control so the entire tools array is prompt-cached. Anthropic
// caches up to (and including) the marked element as one unit.
function toAnthropicTools(tools: ProviderStreamParams["tools"]): AnthropicTool[] {
  return tools.map((t, i) => {
    const tool: AnthropicTool = {
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    };
    if (i === tools.length - 1) {
      (tool as any).cache_control = { type: "ephemeral" };
    }
    return tool;
  });
}

// Convert our normalized SystemPromptInput to Anthropic's system-param shape.
// Structured { stable, persona, dynamic } → up to three text blocks with
// cache_control on stable and persona (two breakpoints). Prefix-match caching
// means a persona swap invalidates only the persona zone; timestamps in
// dynamic never cache but don't pollute the earlier zones. Plain string is
// passed through uncached (used by compaction / tests).
function toAnthropicSystem(input: SystemPromptInput): AnthropicSystem {
  if (typeof input === "string") {
    return input;
  }
  const blocks: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: input.stable,
      cache_control: { type: "ephemeral" },
    } as any,
  ];
  if (input.persona && input.persona.length > 0) {
    blocks.push({
      type: "text",
      text: input.persona,
      cache_control: { type: "ephemeral" },
    } as any);
  }
  if (input.dynamic && input.dynamic.length > 0) {
    blocks.push({ type: "text", text: input.dynamic });
  }
  return blocks;
}

// Mark the last completed assistant turn's final content block with
// cache_control so the conversation prefix caches across turns. Saves one
// breakpoint slot and amortizes per-turn input cost as the transcript grows.
// No-op on turn 1 (no assistant messages yet) and on turns where the last
// message is already an assistant turn (streaming mid-response — shouldn't
// happen at request-send time, but defensive).
function addMessageHistoryCaching(messages: AnthropicMessage[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content) || msg.content.length === 0) continue;
    const lastBlock = msg.content[msg.content.length - 1] as any;
    lastBlock.cache_control = { type: "ephemeral" };
    return;
  }
}

export class ClaudeProvider implements Provider {
  readonly name = "claude";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async *stream(params: ProviderStreamParams): AsyncIterable<ProviderEvent> {
    // Move the per-turn dynamic zone into the latest user message so the
    // system blocks + message history form a stable cache prefix — with it in
    // `system`, the history breakpoint re-wrote the whole conversation cache
    // every turn and never got a cross-turn read.
    const { system, messages } = extractDynamicZone(params.systemPrompt, params.messages);
    const anthropicMessages = toAnthropicMessages(messages);
    const anthropicTools = toAnthropicTools(params.tools);
    addMessageHistoryCaching(anthropicMessages);

    const streamParams: Anthropic.MessageCreateParamsStreaming = {
      model: params.model,
      max_tokens: 16384,
      system: toAnthropicSystem(system) as any,
      messages: anthropicMessages,
      stream: true,
    };

    // Reasoning effort. Effort-capable models (Opus 4.5+/Sonnet 4.6+/Fable) use
    // adaptive thinking + output_config.effort; display:"summarized" keeps the
    // reasoning stream non-empty (Opus 4.7/4.8 default it to "omitted"). Older /
    // Haiku models keep the legacy budget_tokens path (effort 400s on them;
    // budget_tokens 400s on Opus 4.7+). The level is clamped per-model so no
    // request can 400 on an unsupported effort.
    const thinkingLevel = params.thinkingLevel ?? "off";
    if (thinkingLevel !== "off") {
      if (claudeTakesEffort(params.model)) {
        (streamParams as any).thinking = { type: "adaptive", display: "summarized" };
        (streamParams as any).output_config = { effort: clampClaudeEffort(params.model, thinkingLevel) };
        streamParams.max_tokens = 32768;
      } else {
        const budgetMap: Record<string, number> = { low: 4096, medium: 10000, high: 16384, xhigh: 24000, max: 32000 };
        (streamParams as any).thinking = { type: "enabled", budget_tokens: budgetMap[thinkingLevel] ?? 10000 };
        streamParams.max_tokens = 49152; // budget_tokens must be < max_tokens
      }
    }

    // Only include tools if we have any
    if (anthropicTools.length > 0) {
      streamParams.tools = anthropicTools;
    }

    try {
      // Thread the turn's abort signal into the SDK request so /stop and the
      // loop's 90s idle watchdog actually unwind a stalled stream — without it
      // an aborted controller is observed by nothing and the turn hangs.
      const stream = this.client.messages.stream(streamParams, { signal: params.signal });

      // Track block types by index for interleaving
      let currentToolId: string | null = null;
      let inThinkingBlock = false;
      // Input + cache token counts arrive authoritatively on message_start;
      // message_delta is only guaranteed to carry output_tokens. Capture both
      // and merge, preferring whichever actually reported a value.
      let startUsage: { input: number; cacheRead: number; cacheWrite: number } | null = null;

      for await (const event of stream) {
        switch (event.type) {
          case "content_block_start": {
            const block = event.content_block;
            if (block.type === "tool_use") {
              currentToolId = block.id;
              yield { type: "tool_call_start", id: block.id, name: block.name };
            } else if (block.type === "thinking") {
              inThinkingBlock = true;
            }
            break;
          }

          case "content_block_delta": {
            const delta = event.delta as any;
            if (delta.type === "text_delta") {
              yield { type: "text_delta", text: delta.text };
            } else if (delta.type === "input_json_delta" && currentToolId) {
              yield { type: "tool_call_delta", id: currentToolId, args: delta.partial_json };
            } else if (delta.type === "thinking_delta" && inThinkingBlock) {
              yield { type: "thinking_delta", text: delta.thinking };
            }
            break;
          }

          case "content_block_stop": {
            if (currentToolId) {
              yield { type: "tool_call_end", id: currentToolId };
              currentToolId = null;
            } else if (inThinkingBlock) {
              yield { type: "thinking_end" };
              inThinkingBlock = false;
            }
            break;
          }

          case "message_delta": {
            const stopReason = mapStopReason(event.delta.stop_reason ?? null);
            const usage = event.usage as any;
            // input_tokens / cache_read / cache_creation are DISJOINT slices of
            // the prompt on Anthropic — input_tokens alone excludes everything
            // that hit (or seeded) the cache, which on a 4-breakpoint turn is
            // usually the bulk of the context. The gauge wants the whole prompt,
            // so contextTokens sums all three; the billing-shaped fields stay
            // split (the loop's addUsage accumulates them separately).
            const inputTokens = usage?.input_tokens ?? startUsage?.input ?? 0;
            const cacheReadTokens = usage?.cache_read_input_tokens ?? startUsage?.cacheRead ?? 0;
            const cacheWriteTokens = usage?.cache_creation_input_tokens ?? startUsage?.cacheWrite ?? 0;
            yield {
              type: "message_end",
              stopReason,
              usage: {
                inputTokens,
                outputTokens: usage?.output_tokens ?? 0,
                cacheReadTokens,
                cacheWriteTokens,
                contextTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
              },
            };
            break;
          }

          case "message_start": {
            const usage = (event.message as any)?.usage;
            if (usage) {
              startUsage = {
                input: usage.input_tokens ?? 0,
                cacheRead: usage.cache_read_input_tokens ?? 0,
                cacheWrite: usage.cache_creation_input_tokens ?? 0,
              };
            }
            break;
          }
        }
      }
    } catch (err) {
      rethrowIfAborted(err, params.signal);
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", error: `Claude API error: ${message}`, kind: classifyProviderError(err) };
    }
  }
}
