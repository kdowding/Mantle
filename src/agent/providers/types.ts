// Coarse classification of a provider failure, attached to error events so
// consumers can branch on SHAPE instead of regexing message text: the
// delivery outbox discards fatal kinds (auth/bad_request) instead of
// burning 24h of retries, cron backoff can distinguish transient from
// permanent, and the UI can word the surface accordingly. Optional — an
// unclassified error keeps today's behavior everywhere.
export type ProviderErrorKind =
  | "rate_limit"   // 429 — transient, back off
  | "auth"         // 401/403 / missing or expired credentials — fatal until re-auth
  | "network"      // connection-level failure — transient
  | "server"       // 5xx / provider-side fault — transient
  | "bad_request"  // 4xx (excl. 401/403/429) — fatal, retrying sends the same bad input
  | "aborted";     // cancelled — never surfaced as a failure

// Normalized event stream that both providers emit
export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_end" }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; args: string }
  | { type: "tool_call_end"; id: string }
  | { type: "message_end"; stopReason: StopReason; usage: TokenUsage }
  | { type: "error"; error: string; kind?: ProviderErrorKind };

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "error";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** True size of the prompt that was just sent — the "how full is the window"
   *  number the context gauge wants, computed PER PROVIDER because the wire
   *  semantics differ: Anthropic reports input/cacheRead/cacheCreation as
   *  DISJOINT parts (so the total is their sum), while OpenAI/Grok/local report
   *  `prompt_tokens` already inclusive of cached (so the total IS inputTokens).
   *  Consumers fall back to inputTokens when a provider doesn't set it. */
  contextTokens?: number;
  /** Generation speed (tokens/sec) when the provider reports it — currently
   *  the local provider, from llama-server's `timings.predicted_per_second`.
   *  More accurate than a client-side estimate (which times delta arrival). */
  tokensPerSec?: number;
}

// Content blocks for messages
export type MessageContent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  | { type: "image"; fileId: string; mediaType: string; filename: string; size: number }
  | { type: "file"; fileId: string; mediaType: string; filename: string; size: number; extractedText?: string };

export interface ProviderMessage {
  role: "user" | "assistant";
  content: MessageContent[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // Survives provider-side tool curation (the local provider's
  // core/custom toolMode filters). Set by the triggered-turn front door on
  // PSEUDO-tools (channel_yield / channel_react): they're trigger-local
  // controls the turn depends on, not registry tools a curation list could
  // know about — stripping them broke yielding for local-backed speakers.
  // Never serialized to the wire (the per-provider converters map only
  // name/description/schema).
  pinned?: boolean;
}

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";

// System prompt input — three cache zones stacked prefix-to-suffix:
//
//   stable    → identity + workspace files + skills (invalidates only when
//                the user edits a workspace file; should be the same across
//                entire sessions)
//   persona   → active persona profile (invalidates only when the user swaps
//                masks mid-session; otherwise stable)
//   dynamic   → persona transition notice + current time (changes every turn)
//
// On Anthropic, each zone gets its own cache_control breakpoint. Prefix-match
// caching means swapping persona only invalidates the persona zone; the
// timestamp never caches but tools + stable + persona stay hot.
// Plain `string` is used by compaction / test fixtures where caching doesn't
// matter.
export type SystemPromptInput =
  | string
  | { stable: string; persona?: string; dynamic?: string };

export interface ProviderStreamParams {
  messages: ProviderMessage[];
  systemPrompt: SystemPromptInput;
  tools: ToolDefinition[];
  model: string;
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
  /** Codex-subscription fast tier today; providers without support ignore it. */
  fastMode?: boolean;
}

export interface Provider {
  name: string;
  stream(params: ProviderStreamParams): AsyncIterable<ProviderEvent>;
}
