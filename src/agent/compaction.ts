import type { Provider } from "./providers/types.js";
import type { SessionManager, SessionMessage } from "./session.js";
import type { MantleConfig } from "../config/schema.js";
import { getModel, loadRegistry, resolveModelsDir } from "../local/registry.js";

/**
 * Effective compaction threshold (in estimated tokens) for a turn: a fraction
 * (config.session.compactionFraction, default 0.6) of the model's resolved
 * context window. The caller passes the window it already resolved via
 * resolveContextWindow, so this is genuinely "compact at 60% of THIS model's
 * window" — tracking each window (local 8K–64K, Claude 200k, Codex 128–272k,
 * grok-build 512k) instead of a fixed token count that drifts off-% per model.
 * Local folds in for free: its window IS the model's ctx, so it compacts at
 * ctx×fraction, well before llama-server's window overflows.
 */
export function effectiveCompactionThreshold(
  contextWindow: number,
  config: MantleConfig,
): number {
  return Math.floor(contextWindow * config.session.compactionFraction);
}

// Per-provider context window when a model isn't in the user-maintained
// modelContextWindows map. The provider NAME (not the vendor) is what we key
// on, because the same model id can serve different windows across access
// modes — gpt-5.4 is 400k on the ChatGPT API but 272k through Codex, and the
// xai/subscription proxy serves grok-build at 512k. The APIs don't report the
// window, so these are the documented ceilings (verify/adjust per provider).
const PROVIDER_DEFAULT_WINDOW: Record<string, number> = {
  claude: 200_000,
  grok: 256_000,
  openai: 400_000,
  "openai-codex": 272_000,
  "grok-build": 512_000,
};

/**
 * The context window (in tokens) for the model that actually ran this turn —
 * the gauge's ceiling. Resolution, most specific first:
 *   - local         → the model's live ctx from the registry override (or the
 *                     local defaults), because an 8K–64K local window has
 *                     nothing to do with the cloud default.
 *   - codex         → 128k for gpt-5.3-codex-spark, otherwise the 272k lineup
 *                     window, BEFORE the per-model map (a shared id like
 *                     gpt-5.4 must not read the API's larger 400k on the Codex
 *                     backend). grok-build stopped needing
 *                     this once it grew a second model: both its ids resolve
 *                     correctly through the map ("grok-build" 512k, grok-4.5
 *                     500k — the model's own ceiling, which the proxy can't
 *                     exceed), with 512k as the unknown-id fallback below.
 *   - otherwise     → the user-maintained per-model override, then the
 *                     provider default, then the global default.
 * `providerName` is `Provider.name` (claude/grok/openai/openai-codex/grok-build/
 * local) — finer than the vendor, which is what lets the codex/api split work.
 */
export function resolveContextWindow(
  providerName: string,
  model: string,
  config: MantleConfig,
): number {
  if (providerName === "local") {
    try {
      const dir = resolveModelsDir(config.basePath, config.localModels.modelsDir);
      const entry = getModel(loadRegistry(dir), model);
      const ctx = entry?.ctxSize || config.localModels.defaults.ctxSize || 0;
      if (ctx > 0) return ctx;
    } catch {
      /* registry unreadable — fall through to the global default */
    }
    return config.session.defaultContextWindow;
  }
  if (providerName === "openai-codex") {
    return model === "gpt-5.3-codex-spark" ? 128_000 : PROVIDER_DEFAULT_WINDOW[providerName];
  }
  const explicit = config.session.modelContextWindows[model];
  if (explicit) return explicit;
  return PROVIDER_DEFAULT_WINDOW[providerName] ?? config.session.defaultContextWindow;
}

const SUMMARIZATION_PROMPT = `Summarize the prior conversation context concisely. PRESERVE:
- Active tasks and their current status
- Decisions made and their rationale
- The last thing the user requested and what was being done
- TODOs, open questions, and constraints
- Any commitments or follow-ups promised
- Tool calls made and their outcomes (briefly)
PRIORITIZE recent context over older history.
Format as a structured summary, not a narrative.`;

// Hard ceiling on the summarization stream. Compaction runs BEFORE the agent
// loop (so the loop's 90s idle watchdog doesn't cover it) while holding the
// agent lock and a session slot — a hung provider here would wedge the session
// forever with /stop powerless. This deadline guarantees the turn proceeds
// (uncompacted) rather than hanging.
const COMPACTION_TIMEOUT_MS = 90_000;

export interface CompactionParams {
  session: SessionManager;
  provider: Provider;
  model: string;
  threshold: number;
  // The caller's turn signal (chat /stop). Composed with the internal deadline
  // so a user cancel also unwinds a mid-summarization stream. Heartbeat/cron
  // omit it and rely on the deadline alone.
  signal?: AbortSignal;
}

// True when any content block in the message is a tool_result. Such a
// message is only valid when its originating assistant tool_use is also
// present, so the compaction split must never strand one at the head of the
// retained tail.
function messageHasToolResult(message: SessionMessage): boolean {
  return message.content.some((b) => b.type === "tool_result");
}

export async function compactIfNeeded(params: CompactionParams): Promise<boolean> {
  const { session, provider, model, threshold } = params;

  const estimatedTokens = session.estimateTokens();
  if (estimatedTokens < threshold) return false;

  const messages = await session.getMessages();
  // Too few messages to compact (e.g. a handful of giant pastes) — nothing
  // can be summarized away safely. Checked BEFORE the announce log so an
  // over-threshold-but-uncompactable session doesn't spam "compacting..."
  // on every single turn.
  if (messages.length < 4) return false;

  console.log(`[MANTLE:compaction] Transcript ~${estimatedTokens} tokens exceeds threshold ${threshold}, compacting...`);

  // Split: summarize the oldest ~40% by CONTENT WEIGHT, not message count.
  // Messages vary by orders of magnitude (a "thanks" vs a 30KB tool dump) —
  // a count-based cut routinely summarized almost nothing (heavy tail) or
  // nearly everything (heavy head), so compaction barely moved the token
  // needle on the sessions that needed it most.
  const weightOf = (m: SessionMessage): number =>
    m.content.reduce((sum, b) => {
      if (b.type === "text" || b.type === "thinking") return sum + b.text.length;
      if (b.type === "tool_result") return sum + (b.content?.length ?? 0);
      if (b.type === "tool_use") return sum + JSON.stringify(b.input ?? {}).length;
      return sum + 200; // images/files: flat nominal weight
    }, 0);
  const weights = messages.map(weightOf);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let splitPoint = 0;
  let acc = 0;
  while (splitPoint < messages.length && acc < totalWeight * 0.4) {
    acc += weights[splitPoint];
    splitPoint++;
  }
  // Always keep at least the last 2 messages live, and summarize at least 1.
  splitPoint = Math.max(1, Math.min(splitPoint, messages.length - 2));
  // Boundary-safety: a tool_result block lives in a user-role message and is
  // only valid if the assistant tool_use that produced it is still present.
  // The raw cut could land between an assistant tool_use and its following
  // tool_result(s), leaving recentMessages starting with an orphan
  // tool_result whose tool_use got summarized away — which Anthropic (and
  // strict OpenAI-compat backends) reject outright. Advance the boundary past
  // any leading tool_result so the whole tool_use→tool_result pair stays
  // together on the summarized side.
  while (splitPoint < messages.length - 1 && messageHasToolResult(messages[splitPoint])) {
    splitPoint++;
  }
  const oldMessages = messages.slice(0, splitPoint);
  const recentMessages = messages.slice(splitPoint);

  // Build a transcript of old messages for summarization
  const transcriptText = oldMessages
    .map((m) => {
      const textContent = m.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("\n");
      const toolContent = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) => `[Tool: ${(b as any).name}]`)
        .join(", ");
      // The summarizer's prompt asks for "tool calls and their outcomes" —
      // without a slice of each result, tool-heavy stretches summarize as
      // amnesia about what the tools actually returned.
      const toolResultContent = m.content
        .filter((b) => b.type === "tool_result")
        .map((b) => {
          const tr = b as { type: "tool_result"; content: string; isError?: boolean };
          const flat = (tr.content ?? "").replace(/\s+/g, " ").trim();
          const sliced = flat.length > 400 ? `${flat.slice(0, 400)}…` : flat;
          return `[Tool result${tr.isError ? " (error)" : ""}: ${sliced}]`;
        })
        .join(", ");
      const attachmentContent = m.content
        .filter((b) => b.type === "image" || b.type === "file")
        .map((b) => `[Attached: ${(b as any).filename} (${(b as any).mediaType})]`)
        .join(", ");
      const parts = [textContent, toolContent, toolResultContent, attachmentContent].filter(Boolean).join(" ");
      return `${m.role}: ${parts}`;
    })
    .join("\n\n");

  // Ask the LLM to summarize — bounded by the internal deadline (composed with
  // the caller's signal) so a stalled provider can't hang the turn.
  const summaryParts: string[] = [];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), COMPACTION_TIMEOUT_MS);
  const composed = params.signal ? AbortSignal.any([params.signal, ac.signal]) : ac.signal;

  let sawError = false;
  try {
    const stream = provider.stream({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: `${SUMMARIZATION_PROMPT}\n\n---\n\nConversation to summarize:\n\n${transcriptText}` }],
        },
      ],
      systemPrompt: "You are a summarization assistant. Be concise and structured.",
      tools: [],
      model,
      signal: composed,
    });

    for await (const event of stream) {
      if (event.type === "text_delta") summaryParts.push(event.text);
      else if (event.type === "error") sawError = true;
    }
  } finally {
    clearTimeout(timer);
  }

  // An aborted (timed-out / stopped) or errored summarization may have produced
  // partial text — never replace the transcript with a truncated summary.
  if (composed.aborted || sawError) {
    console.log("[MANTLE:compaction] Summarization aborted or errored; leaving transcript intact");
    return false;
  }

  const summary = summaryParts.join("");
  if (!summary) {
    console.log("[MANTLE:compaction] Summarization produced empty result, skipping");
    return false;
  }

  // Replace old messages with a summary system message
  const summaryMessage: SessionMessage = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    role: "system",
    content: [{ type: "text", text: `[Conversation Summary]\n\n${summary}` }],
  };

  // Rebuild: summary + recent messages
  // Convert the system summary to a user message for provider compatibility
  const compactedMessages: SessionMessage[] = [
    {
      ...summaryMessage,
      role: "user",
      content: [{ type: "text", text: `[Prior conversation context, compacted]\n\n${summary}` }],
    },
    ...recentMessages,
  ];

  await session.replaceMessages(compactedMessages);

  const newTokens = session.estimateTokens();
  console.log(`[MANTLE:compaction] Compacted: ${estimatedTokens} → ~${newTokens} tokens (${messages.length} → ${compactedMessages.length} messages)`);

  return true;
}
