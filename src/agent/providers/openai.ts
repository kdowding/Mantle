import OpenAI from "openai";
import type { Provider, ProviderEvent, ProviderStreamParams, ThinkingLevel } from "./types.js";
import { toOpenAIMessages, toOpenAITools, streamChatCompletions } from "./openai-chat.js";
import { rethrowIfAborted, classifyProviderError } from "./provider-utils.js";

// ChatGPT API (api.openai.com, Chat Completions) — the API-key counterpart to
// the openai-codex subscription backend. A thin request-builder over the shared
// streamChatCompletions loop, exactly like Grok (api.x.ai) and Local
// (llama-server). The whole "add a new provider" cost is this file + one
// catalog cell; it then appears in the picker automatically.
//
// GPT-5 reasoning models on the public API accept `reasoning_effort`
// (low/medium/high). mantle's ThinkingLevel maps off→omit; xhigh/max clamp down
// to high here (the Codex BACKEND additionally takes xhigh — see openai-codex.ts).
function mapReasoningEffort(level: ThinkingLevel | undefined): "low" | "medium" | "high" | undefined {
  switch (level) {
    case "low": return "low";
    case "medium": return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
    default: return undefined; // "off" / unset → omit the field
  }
}

export class OpenAiProvider implements Provider {
  readonly name = "openai";
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey }); // defaults to https://api.openai.com/v1
  }

  async *stream(params: ProviderStreamParams): AsyncIterable<ProviderEvent> {
    const requestParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: params.model,
      messages: toOpenAIMessages(params.messages, params.systemPrompt),
      stream: true,
      // Without this OpenAI streams no usage chunk at all — every ChatGPT-API
      // turn reported 0/0 tokens. (xAI sends usage unprompted; llama-server
      // sets this in its own builder.)
      stream_options: { include_usage: true },
    };

    const effort = mapReasoningEffort(params.thinkingLevel);
    if (effort) {
      (requestParams as { reasoning_effort?: string }).reasoning_effort = effort;
    }

    const tools = toOpenAITools(params.tools);
    if (tools.length > 0) requestParams.tools = tools;

    try {
      // Pass the turn signal so /stop + the idle watchdog can abort a stalled stream.
      const stream = await this.client.chat.completions.create(requestParams, { signal: params.signal });
      yield* streamChatCompletions(stream);
    } catch (err) {
      rethrowIfAborted(err, params.signal);
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", error: `ChatGPT API error: ${message}`, kind: classifyProviderError(err) };
    }
  }
}
