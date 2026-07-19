/**
 * Local provider — talks to a llama.cpp `llama-server` over its
 * OpenAI-compatible Chat-Completions API at `http://<host>:<port>/v1`. The
 * server process is owned by LocalModelManager (spawn/swap/health); this
 * provider preflights the right model into memory, builds the request with
 * local-specific knobs, and hands the stream to the shared chat loop.
 *
 * Local-specific bits layered on top of the shared chat-completions path:
 *   - Preflight load with keep-alive thinking ticks so a cold multi-GB load
 *     doesn't trip the agent loop's 90s idle watchdog.
 *   - Per-model tool curation (toolMode off/core/custom/all): the full ~76-tool
 *     surface overflows llama.cpp's --jinja tool-call grammar and swamps small
 *     models, so "core" (the default) sends a small curated subset.
 *   - Per-request sampling resolved from the model's settings (no reload).
 *   - enable_thinking template kwarg for hybrid reasoners (Qwen3 etc.).
 *   - stream_options.include_usage so llama-server reports token usage; the
 *     inline <think> splitter (shared) catches templated CoT in content.
 */

import OpenAI from "openai";
import type { Provider, ProviderEvent, ProviderStreamParams } from "./types.js";
import type { LocalModelManager } from "../../local/manager.js";
import { toOpenAIMessages, toOpenAITools, createThinkSplitter, streamChatCompletions } from "./openai-chat.js";
import { rethrowIfAborted, classifyProviderError } from "./provider-utils.js";

const LOAD_TICK_MS = 15_000;

// Curated tool subset for toolMode "core". Deliberately small: llama.cpp's
// --jinja tool-call grammar is built from the advertised tools, and the full
// mantle surface overflows its grammar-size limit (and swamps small models).
const CORE_LOCAL_TOOLS = new Set<string>([
  "read_file", "write_file", "edit_file", "list_directory", "glob_files", "grep_files",
  "bash", "web_fetch",
  "remember", "recall", "recall_source", "memory_status",
  "sessions_list", "sessions_history",
]);

export class LocalProvider implements Provider {
  readonly name = "local";

  constructor(private readonly manager: LocalModelManager) {}

  async *stream(params: ProviderStreamParams): AsyncIterable<ProviderEvent> {
    const model = params.model;
    const info = this.manager.describeModel(model);
    const toolMode = info?.toolMode ?? "core";
    const allowedTools = new Set(info?.allowedTools ?? []);
    const useThinkSplitter = info?.reasoning ?? false;
    const sampling = info?.sampling;

    // ── Preflight: load the requested model and pin it for this turn. pin:true
    // makes the manager take the generation pin atomically under its load lock,
    // so a concurrent turn for a different model can't tear this server down
    // between our load and our stream. The pin is held only if the load
    // resolves; `pinned` flips inside the load promise's own continuation, so
    // it's already set when control returns here and the finally releases
    // exactly what we acquired. A cold load can be slow, so we feed the agent
    // loop's 90s idle watchdog keep-alive thinking ticks meanwhile.
    let pinned = false;
    // Flipped by the outer finally. If the consumer abandons this generator
    // while it's suspended at a keep-alive tick (the runtime calls return(),
    // running finallys at the CURRENT suspension point), the in-flight load
    // can still resolve afterwards and take the pin — with nobody left to
    // release it, every future model swap would refuse "busy". The load
    // continuation checks this flag and releases the just-acquired pin itself.
    let abandoned = false;
    let announcedLoad = false;
    const coldStart = !this.manager.isModelReady(model);
    const loadPromise = this.manager
      .ensureModelLoaded(model, { signal: params.signal, pin: true })
      .then(() => {
        if (abandoned) {
          this.manager.endGeneration();
        } else {
          pinned = true;
        }
      });

    // One try/finally covers EVERYTHING from here — including the cold-load
    // keep-alive loop, which previously sat outside the pin-releasing finally.
    try {
      if (coldStart) {
        const done = loadPromise.then(() => "done" as const);
        // If an abort breaks the loop before we await `done`, don't leak an
        // unhandled rejection — the real error still surfaces via the race await.
        void done.catch(() => {});
        try {
          for (;;) {
            const winner = await Promise.race([
              done,
              new Promise<"tick">((r) => setTimeout(() => r("tick"), LOAD_TICK_MS)),
            ]);
            if (winner === "done") break;
            if (params.signal?.aborted) break;
            yield announcedLoad
              ? { type: "thinking_delta", text: " ·" }
              : { type: "thinking_delta", text: `Loading ${model} into memory…` };
            announcedLoad = true;
          }
        } catch (err) {
          if (announcedLoad) yield { type: "thinking_end" };
          rethrowIfAborted(err, params.signal);
          yield {
            type: "error",
            error: `Local model load failed: ${err instanceof Error ? err.message : String(err)}`,
            kind: "server",
          };
          return;
        }
      } else {
        try {
          await loadPromise;
        } catch (err) {
          rethrowIfAborted(err, params.signal);
          yield {
            type: "error",
            error: `Local model load failed: ${err instanceof Error ? err.message : String(err)}`,
            kind: "server",
          };
          return;
        }
      }

      if (announcedLoad) yield { type: "thinking_end" };

      // ── Build the request (local-specific knobs) ─────────────────────────
      const client = new OpenAI({
        apiKey: "sk-local", // llama-server ignores it; the SDK requires non-empty
        baseURL: `${this.manager.baseUrl()}/v1`,
      });

      const messages = toOpenAIMessages(params.messages, params.systemPrompt);

      // Curate tools per the model's toolMode (the full surface overflows the
      // --jinja grammar). "all" advertises everything (unchanged). PINNED
      // tools (trigger pseudo-tools like channel_yield/channel_react) always
      // survive curation — they're per-turn controls the front door injected,
      // not registry tools a static list could name. toolMode "off" still
      // strips everything: a no-tools model can't emit tool calls at all.
      const pinnedNames = new Set(params.tools.filter((t) => t.pinned).map((t) => t.name));
      let tools = toOpenAITools(params.tools);
      if (toolMode === "off") {
        tools = [];
      } else if (toolMode === "core") {
        tools = tools.filter((t) => CORE_LOCAL_TOOLS.has(t.function.name) || pinnedNames.has(t.function.name));
      } else if (toolMode === "custom") {
        tools = tools.filter((t) => allowedTools.has(t.function.name) || pinnedNames.has(t.function.name));
      }

      const requestParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true }, // llama-server only reports usage when set
      };
      if (tools.length > 0) requestParams.tools = tools;

      // Sampling — sent per-request, so edits apply on the next message with no
      // reload. Sentinels (knobs < 0, maxTokens 0) mean "omit, use llama.cpp's
      // default". top_k / min_p / repeat_penalty / max_tokens are llama.cpp
      // OpenAI-compat extensions absent from the SDK type, attached via a cast
      // (the SDK serializes unknown keys straight into the body).
      if (sampling) {
        if (sampling.temperature >= 0) requestParams.temperature = sampling.temperature;
        if (sampling.topP >= 0) requestParams.top_p = sampling.topP;
        const extra = requestParams as unknown as Record<string, unknown>;
        if (sampling.maxTokens > 0) extra.max_tokens = sampling.maxTokens;
        if (sampling.topK >= 0) extra.top_k = sampling.topK;
        if (sampling.minP >= 0) extra.min_p = sampling.minP;
        if (sampling.repeatPenalty >= 0) extra.repeat_penalty = sampling.repeatPenalty;
      }

      // Per-turn reasoning control for hybrid reasoners: the thinking toggle
      // maps to llama.cpp's `enable_thinking` template kwarg. Only sent for
      // reasoning-capable models; non-Qwen templates ignore it harmlessly.
      if (info?.reasoning) {
        const enableThinking = params.thinkingLevel != null && params.thinkingLevel !== "off";
        (requestParams as unknown as Record<string, unknown>).chat_template_kwargs = {
          enable_thinking: enableThinking,
        };
      }

      const stream = await client.chat.completions.create(requestParams, { signal: params.signal });
      yield* streamChatCompletions(stream, {
        splitter: useThinkSplitter ? createThinkSplitter() : null,
      });
    } catch (err) {
      rethrowIfAborted(err, params.signal);
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", error: `Local model error: ${message}`, kind: classifyProviderError(err) };
    } finally {
      // Runs on normal completion, thrown error, AND consumer abandonment at
      // any suspension point above (incl. the cold-load ticks). If the load
      // hasn't resolved yet, `abandoned` tells its continuation to release
      // the pin the moment it's taken.
      abandoned = true;
      if (pinned) this.manager.endGeneration();
    }
  }
}
