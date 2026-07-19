import OpenAI from "openai";
import type { Provider, ProviderEvent, ProviderStreamParams, ThinkingLevel } from "./types.js";
import { toOpenAIMessages, toOpenAITools, streamChatCompletions } from "./openai-chat.js";
import { rethrowIfAborted, classifyProviderError } from "./provider-utils.js";

// xAI's `reasoning_effort` is only accepted by models with a single,
// configurable reasoning surface — grok-4.3 and grok-4.5 as of 2026-07. The
// split lineups (grok-4.20-0309-*, grok-4-1-fast-*) expose reasoning depth as
// a model-id choice and reject the param with a 400. Keep this map narrow: be
// additive when xAI ships new configurable models.
//
// The value is the model's FLOOR — what "off"/unset maps to. grok-4.3 can
// disable reasoning entirely ("none"). grok-4.5 cannot: it accepts only
// low/medium/high and DEFAULTS TO HIGH when the param is omitted, so we always
// send an explicit value and "off" clamps to "low" (the fastest it goes)
// instead of a 400 or a silent max-latency default.
const REASONING_EFFORT_FLOOR: Readonly<Record<string, "none" | "low">> = {
  "grok-4.3": "none",
  "grok-4.5": "low",
};

// Mantle's ThinkingLevel → xAI's reasoning_effort enum, clamped to [floor, high].
// Exported: the Grok Build provider reuses it — grok-4.5 behind the
// subscription proxy is the same engine with the same effort semantics
// (grok-build.ts PROXY_REASONING_EFFORT_FLOOR gates which models get it there).
export function mapReasoningEffort(
  level: ThinkingLevel | undefined,
  floor: "none" | "low",
): "none" | "low" | "medium" | "high" {
  switch (level) {
    case "low": return "low";
    case "medium": return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high"; // the configurable models top out at high — clamp the upper levels down
    default: return floor; // off / unset
  }
}

export class GrokProvider implements Provider {
  readonly name = "grok";
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, baseURL: "https://api.x.ai/v1" });
  }

  async *stream(params: ProviderStreamParams): AsyncIterable<ProviderEvent> {
    const requestParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: params.model,
      messages: toOpenAIMessages(params.messages, params.systemPrompt),
      stream: true,
    };

    // Only the configurable-reasoning models take reasoning_effort; the
    // split *-reasoning/*-non-reasoning models reject it (400).
    const effortFloor = REASONING_EFFORT_FLOOR[params.model];
    if (effortFloor) {
      (requestParams as { reasoning_effort?: string }).reasoning_effort =
        mapReasoningEffort(params.thinkingLevel, effortFloor);
    }

    const tools = toOpenAITools(params.tools);
    if (tools.length > 0) requestParams.tools = tools;

    try {
      // Pass the turn signal so /stop + the idle watchdog can abort a stalled
      // stream (this is the default backend — without it a hung SSE wedges the
      // turn and its session lock until restart).
      const stream = await this.client.chat.completions.create(requestParams, { signal: params.signal });
      yield* streamChatCompletions(stream);
    } catch (err) {
      rethrowIfAborted(err, params.signal);
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", error: `Grok API error: ${message}`, kind: classifyProviderError(err) };
    }
  }
}
