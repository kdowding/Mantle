/**
 * OpenAI Codex provider — talks to the ChatGPT-subscription Responses API at
 * `chatgpt.com/backend-api/codex`. Uses OAuth tokens managed by
 * `src/auth/openai-codex.ts` (set up via `mantle auth login`).
 *
 * Differs from the regular OpenAI Responses API:
 *   - baseURL is chatgpt.com/backend-api/codex (subscription), not api.openai.com
 *   - Bearer auth uses the OAuth access token; ChatGPT-Account-Id header required
 *   - Streaming is mandatory (server rejects stream:false)
 *   - System prompt goes in top-level `instructions`, NOT a system message
 *   - `input` is the strict list shape: [{type:"message", role, content:[{type:"input_text", text}]}]
 *   - Fast mode sends `service_tier:"priority"`; it is omitted otherwise.
 *     The CLI-sugar value `"fast"` is rejected with HTTP 400 (2026-07-17).
 *   - Banned params (must NOT send): max_output_tokens, metadata,
 *     prompt_cache_retention, temperature
 *
 * The streaming event loop is shared with the Grok Build provider via
 * `streamResponsesEvents` — only the request shape below is codex-specific.
 */

import OpenAI from "openai";
import type { ResponseStreamEvent, ResponseInputItem } from "openai/resources/responses/responses";
import { ensureValidCodexAccess, CodexAuthError } from "../../auth/openai-codex.js";
import type {
  Provider,
  ProviderEvent,
  ProviderStreamParams,
  ProviderMessage,
  SystemPromptInput,
  ThinkingLevel,
} from "./types.js";
import { flattenSystemPrompt, extractDynamicZone, rethrowIfAborted, classifyProviderError } from "./provider-utils.js";
import { streamResponsesEvents, toResponsesTools } from "./openai-responses.js";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const ORIGINATOR = "mantle";
const VERSION = "0.1.0";

// Verified from the client-version-filtered Codex catalog and live Responses
// probes on 2026-07-17. The 5.6 trio accepts max; older listed models top out at
// xhigh, so Mantle's max preference clamps to high there. Omitted means the
// server chooses its per-model default; explicit off requests the low floor.
export const CODEX_MAX_EFFORT_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

export function mapCodexReasoningEffort(
  level: ThinkingLevel | undefined,
  model: string,
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  if (level === undefined) return undefined;
  if (level === "off") return "low";
  if (level === "max") return CODEX_MAX_EFFORT_MODELS.has(model) ? "max" : "high";
  return level;
}

// Models whose 2026-07-17 catalog entry advertises the `priority` service tier.
// gpt-5.5 stays for users who hand-add the retired model to their config.
export const CODEX_FAST_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
]);

// Codex uses `instructions` (one string) in place of a system message. Server
// auto-caches by prefix, so keep stable content first (flattenSystemPrompt).
function flattenInstructions(input: SystemPromptInput): string | undefined {
  const joined = flattenSystemPrompt(input);
  return joined.length > 0 ? joined : undefined;
}

// Mantle messages → Responses input items. Codex uses the strict nested shape:
// {type:"message", role, content:[{type:"input_text"|"output_text", text}]}.
// Tool calls/results are their own function_call / function_call_output items.
function toResponsesInput(messages: ProviderMessage[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const textBlocks = msg.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text");
      const toolResults = msg.content.filter((b): b is Extract<typeof b, { type: "tool_result" }> => b.type === "tool_result");
      // image_url parts are injected by resolveAttachmentsForProvider for
      // non-anthropic vendors ({type:"image_url", image_url:{url:dataURL}})
      // — an out-of-union shape, hence the cast (same pattern as the
      // chat-completions mapper). Responses input wants
      // {type:"input_image", image_url:"<url>"} — silently dropping them
      // meant Codex never saw uploaded images.
      const imageBlocks = msg.content.filter(
        (b) => (b as { type?: string }).type === "image_url",
      ) as unknown as Array<{ type: "image_url"; image_url: { url: string } }>;
      for (const tr of toolResults) {
        items.push({ type: "function_call_output", call_id: tr.toolUseId, output: tr.content } as ResponseInputItem);
      }
      if (textBlocks.length > 0 || imageBlocks.length > 0) {
        items.push({
          type: "message",
          role: "user",
          content: [
            ...textBlocks.map((b) => ({ type: "input_text" as const, text: b.text })),
            ...imageBlocks.map((b) => ({ type: "input_image" as const, image_url: b.image_url.url, detail: "auto" as const })),
          ],
        } as ResponseInputItem);
      }
    } else if (msg.role === "assistant") {
      const textBlocks = msg.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text");
      const toolUses = msg.content.filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use");
      if (textBlocks.length > 0) {
        items.push({
          type: "message",
          role: "assistant",
          content: textBlocks.map((b) => ({ type: "output_text" as const, text: b.text, annotations: [] })),
        } as unknown as ResponseInputItem);
      }
      for (const tu of toolUses) {
        items.push({
          type: "function_call",
          call_id: tu.id,
          name: tu.name,
          arguments: JSON.stringify(tu.input),
        } as ResponseInputItem);
      }
    }
  }
  return items;
}

export class OpenAICodexProvider implements Provider {
  readonly name = "openai-codex";
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  async *stream(params: ProviderStreamParams): AsyncIterable<ProviderEvent> {
    // Refresh access token if needed (in-process dedup prevents racing
    // refreshes from concurrent agent turns).
    let access: string;
    let accountId: string;
    try {
      const auth = await ensureValidCodexAccess(this.basePath);
      access = auth.access;
      accountId = auth.identity.accountId;
    } catch (err) {
      const message =
        err instanceof CodexAuthError
          ? `OpenAI Codex auth: ${err.message}`
          : `OpenAI Codex auth: ${err instanceof Error ? err.message : String(err)}`;
      yield { type: "error", error: message, kind: "auth" };
      return;
    }

    // New client per call — the access token may have just rotated.
    const client = new OpenAI({
      apiKey: access,
      baseURL: CODEX_BASE_URL,
      defaultHeaders: {
        "ChatGPT-Account-Id": accountId,
        originator: ORIGINATOR,
        "User-Agent": `${ORIGINATOR}/${VERSION}`,
      },
    });

    // Per-turn dynamic content rides in the latest user message, not in
    // `instructions` — keeps instructions + history a stable prefix for the
    // server-side prompt cache (see extractDynamicZone).
    const { system, messages } = extractDynamicZone(params.systemPrompt, params.messages);
    const reasoningEffort = mapCodexReasoningEffort(params.thinkingLevel, params.model);
    const requestBody: Record<string, unknown> = {
      model: params.model,
      input: toResponsesInput(messages),
      stream: true,
      store: false,
    };
    if (params.fastMode && CODEX_FAST_MODELS.has(params.model)) {
      requestBody.service_tier = "priority";
    }
    const instructions = flattenInstructions(system);
    if (instructions) requestBody.instructions = instructions;
    const tools = toResponsesTools(params.tools);
    if (tools.length > 0) requestBody.tools = tools;
    // `summary:"auto"` requested defensively in case codex ever surfaces
    // reasoning summaries to third-party callers (currently stripped).
    if (reasoningEffort) {
      requestBody.reasoning = { effort: reasoningEffort, summary: "auto" };
    }

    try {
      const stream = (await client.responses.create(requestBody as never, {
        signal: params.signal,
      })) as unknown as AsyncIterable<ResponseStreamEvent>;
      yield* streamResponsesEvents(stream, { errorLabel: "OpenAI Codex" });
    } catch (err) {
      rethrowIfAborted(err, params.signal);
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", error: `OpenAI Codex API error: ${message}`, kind: classifyProviderError(err) };
    }
  }
}
