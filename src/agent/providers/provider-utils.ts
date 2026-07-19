import type { ProviderErrorKind, ProviderMessage, SystemPromptInput } from "./types.js";

// Classify a thrown SDK error into a ProviderErrorKind. Both the Anthropic
// and OpenAI SDKs expose `.status` on their APIError classes; connection
// failures surface as APIConnectionError / fetch TypeError with no status.
export function classifyProviderError(err: unknown): ProviderErrorKind {
  const name = err instanceof Error ? err.name : "";
  if (name === "AbortError" || name === "APIUserAbortError") return "aborted";
  if (name === "APIConnectionError" || name === "APIConnectionTimeoutError") return "network";
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number") {
    if (status === 429) return "rate_limit";
    if (status === 401 || status === 403) return "auth";
    if (status >= 500) return "server";
    if (status >= 400) return "bad_request";
  }
  // fetch-level failures (DNS, refused) come through as TypeError in Bun.
  if (err instanceof TypeError) return "network";
  return "server";
}

// Rethrow abort-shaped failures instead of letting a provider wrap them as
// {type:"error"} events. Every provider catch calls this FIRST: when the
// turn's composed signal fired (/stop, the 90s idle watchdog, the turn
// deadline) the SDK throws inside the provider's try — converting that to a
// yielded error event made the loop classify every abort as a provider
// failure, which killed its idle-timeout friendly-retry and turn-deadline
// graceful-landing branches (the loop's catch is the ONLY place that can
// tell those apart). The signal check is authoritative; the name checks
// cover abort-shaped throws from SDKs that wrap (Anthropic's
// APIUserAbortError, undici's AbortError).
export function rethrowIfAborted(err: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) throw err;
  if (err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError")) {
    throw err;
  }
}

// Collapse the structured prompt zones (stable / persona / dynamic) into one
// string, most-stable-first so a provider's prefix cache keeps the longest
// possible hot prefix (only the dynamic tail invalidates each turn). Used by
// every OpenAI-shaped provider (chat-completions AND Responses families) and
// by anything that needs the prompt as a flat string. Anthropic doesn't use
// this — it keeps the zones as separate cache-controlled blocks.
export function flattenSystemPrompt(input: SystemPromptInput): string {
  if (typeof input === "string") return input;
  const parts = [input.stable];
  if (input.persona && input.persona.length > 0) parts.push(input.persona);
  if (input.dynamic && input.dynamic.length > 0) parts.push(input.dynamic);
  return parts.join("\n\n---\n\n");
}

// Move the per-turn DYNAMIC zone (memory pack, persona-transition note,
// current date/time, skills catalog) out of the system prompt and into the
// latest REAL user message, returning a reduced system + adjusted messages.
//
// Why: the dynamic zone changes every turn, and in cache-prefix order the
// system prompt sits BEFORE the message history — so with it in `system`,
// every provider's prompt cache (Anthropic's explicit breakpoints AND the
// OpenAI-shaped providers' automatic prefix caching) invalidated the ENTIRE
// conversation history every single turn: a full re-write, never a
// cross-turn read. Splicing it into the newest user message makes the
// system prompt + history a stable prefix; the only re-cached span per turn
// is the previous turn's tail (the splice point moves forward each turn).
//
// "Real" user message = one carrying actual user content, not a synthetic
// tool_result-only message — the splice point must stay FIXED across the
// iterations of a turn (tool_result messages keep appending after it), or
// the within-turn cache would churn too.
//
// Falls through unchanged (dynamic stays in system) for plain-string prompts
// (compaction), an empty dynamic zone, or a transcript with no real user
// message to host the block.
export function extractDynamicZone(
  input: SystemPromptInput,
  messages: ProviderMessage[],
): { system: SystemPromptInput; messages: ProviderMessage[] } {
  if (typeof input === "string" || !input.dynamic || input.dynamic.trim().length === 0) {
    return { system: input, messages };
  }
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (m.content.some((b) => b.type === "tool_result")) continue;
    idx = i;
    break;
  }
  if (idx === -1) return { system: input, messages };

  // Session-position stamp. Because the block rides ONLY the latest real user
  // message (history is stored clean), every request's newest message is the
  // one wearing a context brief + timestamp — the exact shape of a
  // conversation's FIRST message, and weaker models (grok-4.20 lineage) read
  // that as session start and re-greet mid-chat. Naming the position outright
  // ("session turn 14") contradicts the misread. The ordinal is positional
  // within the VISIBLE transcript, not a session ledger — compaction collapses
  // history and renumbers; the signal is "not the first message", not an
  // exact count.
  let turn = 0;
  for (let i = 0; i <= idx; i++) {
    const m = messages[i];
    if (m.role === "user" && !m.content.some((b) => b.type === "tool_result")) turn++;
  }
  const position = turn === 1 ? "session start" : `session turn ${turn}`;

  const out = messages.slice();
  out[idx] = {
    role: "user",
    content: [
      {
        type: "text",
        text:
          `[Per-turn context — ${position} — assembled by the harness, not written by the user]\n\n` +
          `${input.dynamic}\n\n[End per-turn context]`,
      },
      ...messages[idx].content,
    ],
  };
  return { system: { ...input, dynamic: "" }, messages: out };
}
