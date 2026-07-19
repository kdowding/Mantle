/**
 * Grok Build provider — talks to the X / SuperGrok-subscription Responses API
 * at cli-chat-proxy.grok.com/v1. Uses OAuth tokens managed by
 * src/auth/grok-build.ts (reused from the user's grok build login at
 * ~/.grok/auth.json).
 *
 * Wire protocol (captured 2026-05-14 from grok build 0.1.210):
 *   - baseURL cli-chat-proxy.grok.com/v1 (subscription proxy); POST /responses
 *   - Bearer auth (OAuth access token); x-grok-* headers identify the client
 *   - Body is vanilla OpenAI Responses API — the proxy reports
 *     api_backend:"responses", so the streaming event loop is shared with the
 *     codex provider (streamResponsesEvents).
 *   - System prompt goes in the `input` array as a {role:"system"} message item
 *     with PLAIN-STRING content — NOT codex's top-level `instructions`, and NOT
 *     a nested content-part array.
 *   - reasoning: the proxy declares effort support PER MODEL
 *     (supports_reasoning_effort in GET /v1/models — probed 2026-07-16).
 *     grok-4.5 takes reasoning.effort low/medium/high (verified live: the
 *     response echoes the effort back); the "grok-build" alias still 400s on
 *     the param ("does not support parameter reasoningEffort"), so effort is
 *     sent only for models in PROXY_REASONING_EFFORT_FLOOR. Either way
 *     reasoning.summary:"concise" + include:["reasoning.encrypted_content"]
 *     mirror grok build's own shape.
 */

import OpenAI from "openai";
import type { ResponseStreamEvent, ResponseInputItem } from "openai/resources/responses/responses";
import { ensureValidGrokAccess, GrokAuthError } from "../../auth/grok-build.js";
import type {
  Provider,
  ProviderEvent,
  ProviderStreamParams,
  ProviderMessage,
  SystemPromptInput,
} from "./types.js";
import { flattenSystemPrompt, extractDynamicZone, rethrowIfAborted, classifyProviderError } from "./provider-utils.js";
import { streamResponsesEvents, toResponsesTools } from "./openai-responses.js";
import { mapReasoningEffort } from "./grok.js";

const GROK_BUILD_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const GROK_CLIENT_IDENTIFIER = "grok-shell";
const GROK_CLIENT_VERSION = "0.1.210";

// Which proxy models take reasoning.effort, and each one's floor — the proxy
// declares this per model (GET /v1/models supports_reasoning_effort, probed
// 2026-07-16). grok-4.5 is the same engine as the API side: it can't disable
// reasoning and DEFAULTS TO HIGH when the param is omitted, so we always send
// an explicit value and "off" clamps to "low" (see grok.ts). The "grok-build"
// alias rejects the param with a 400 — models absent here never get it.
const PROXY_REASONING_EFFORT_FLOOR: Readonly<Record<string, "low">> = {
  "grok-4.5": "low",
};

// Mantle messages → Responses input items. grok build's captured request uses
// message items with PLAIN-STRING `content` (not codex's nested input_text
// arrays), and prepends the system prompt as a {role:"system"} item.
function toGrokInput(messages: ProviderMessage[], systemPrompt: SystemPromptInput): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];

  // Per-turn dynamic content rides in the latest user message, not the system
  // item — keeps the system + history a stable prefix for the proxy's prompt
  // cache (see extractDynamicZone).
  const { system, messages: spliced } = extractDynamicZone(systemPrompt, messages);
  const sys = flattenSystemPrompt(system);
  if (sys.length > 0) {
    items.push({ type: "message", role: "system", content: sys } as ResponseInputItem);
  }

  for (const msg of spliced) {
    if (msg.role === "user") {
      const textBlocks = msg.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text");
      const toolResults = msg.content.filter((b): b is Extract<typeof b, { type: "tool_result" }> => b.type === "tool_result");
      // The grok proxy's captured wire shape is PLAIN-STRING message content
      // — there's no verified image part to map injected image_url blocks
      // onto, so surface an explicit marker instead of silently dropping
      // them (the model should know an image was attached and unviewable).
      const imageCount = msg.content.filter((b: { type: string }) => b.type === "image_url").length;
      const textParts = textBlocks.map((b) => b.text);
      if (imageCount > 0) {
        textParts.push(`[${imageCount} image attachment${imageCount === 1 ? "" : "s"} omitted — the Grok Build backend can't view images]`);
      }
      for (const tr of toolResults) {
        items.push({ type: "function_call_output", call_id: tr.toolUseId, output: tr.content } as ResponseInputItem);
      }
      if (textParts.length > 0) {
        items.push({
          type: "message",
          role: "user",
          content: textParts.join("\n"),
        } as ResponseInputItem);
      }
    } else if (msg.role === "assistant") {
      const textBlocks = msg.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text");
      const toolUses = msg.content.filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use");
      if (textBlocks.length > 0) {
        items.push({
          type: "message",
          role: "assistant",
          content: textBlocks.map((b) => b.text).join("\n"),
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

export class GrokBuildProvider implements Provider {
  readonly name = "grok-build";
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  async *stream(params: ProviderStreamParams): AsyncIterable<ProviderEvent> {
    let access: string;
    let userId: string;
    try {
      const auth = await ensureValidGrokAccess(this.basePath);
      access = auth.access;
      userId = auth.identity.userId;
    } catch (err) {
      const message =
        err instanceof GrokAuthError
          ? `Grok Build auth: ${err.message}`
          : `Grok Build auth: ${err instanceof Error ? err.message : String(err)}`;
      yield { type: "error", error: message, kind: "auth" };
      return;
    }

    // New client per call — the access token may have just rotated.
    const client = new OpenAI({
      apiKey: access, // → Authorization: Bearer <access>
      baseURL: GROK_BUILD_BASE_URL,
      defaultHeaders: {
        "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
        "x-grok-client-version": GROK_CLIENT_VERSION,
        "x-grok-model-override": params.model,
        "x-grok-user-id": userId,
      },
    });

    // Encrypted reasoning content + concise summary, matching grok build's
    // shape. reasoning.effort rides along only for models the proxy declares
    // support for (grok-4.5) — the "grok-build" alias 400s on the param.
    const effortFloor = PROXY_REASONING_EFFORT_FLOOR[params.model];
    const reasoning: Record<string, unknown> = { summary: "concise" };
    if (effortFloor) reasoning.effort = mapReasoningEffort(params.thinkingLevel, effortFloor);
    const requestBody: Record<string, unknown> = {
      model: params.model,
      input: toGrokInput(params.messages, params.systemPrompt),
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning,
    };
    const tools = toResponsesTools(params.tools);
    if (tools.length > 0) requestBody.tools = tools;

    try {
      const stream = (await client.responses.create(requestBody as never, {
        signal: params.signal,
      })) as unknown as AsyncIterable<ResponseStreamEvent>;
      yield* streamResponsesEvents(stream, { errorLabel: "Grok Build" });
    } catch (err) {
      rethrowIfAborted(err, params.signal);
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", error: `Grok Build API error: ${message}`, kind: classifyProviderError(err) };
    }
  }
}
