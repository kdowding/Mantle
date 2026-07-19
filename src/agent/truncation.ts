// Tool-result truncation. Some tools can return large outputs (huge file
// reads, web fetches that already capped at 50KB but still chunky, MCP
// tools dumping unbounded JSON). Without per-result truncation, a single
// noisy turn can crowd the context window before compaction kicks in,
// or push us over the model's limit mid-loop.
//
// Strategy: head + tail. Keep the start (for setup/context) AND the end
// (errors, summaries, exit codes — bash appends [stderr] last; many CLI
// tools end with the most important line). Replace the middle with a
// marker so the model knows truncation happened and can ask for more if
// needed.

export interface TruncateOptions {
  // Hard cap on the truncated string's length, in characters. Default
  // ~24K chars ≈ 6K tokens — generous per-tool, but bounded enough that
  // a chatty tool doesn't unilaterally consume a quarter of a 100K-token
  // context window.
  maxChars?: number;
  // Fraction of the budget to spend on the head. 0.8 keeps 80% from the
  // start and 20% from the end — good default for stack traces, error
  // tails, and the typical "context up front, conclusion at the bottom"
  // shape of CLI/tool output.
  headRatio?: number;
  // Don't truncate at all unless we'd save at least this many chars.
  // Avoids cosmetic truncation that loses 50 chars and adds an "omitted"
  // marker that costs almost as much.
  minSavings?: number;
}

const DEFAULT_MAX_CHARS = 24_000;
const DEFAULT_HEAD_RATIO = 0.8;
const DEFAULT_MIN_SAVINGS = 500;
// Reserve a fixed budget for the omission marker text so the actual
// content fits in maxChars. Slightly conservative — the marker is
// usually shorter than this — but predictable.
const MARKER_BUDGET = 96;

export function truncateToolResult(
  content: string,
  options: TruncateOptions = {},
): string {
  const max = options.maxChars ?? DEFAULT_MAX_CHARS;
  const headRatio = options.headRatio ?? DEFAULT_HEAD_RATIO;
  const minSavings = options.minSavings ?? DEFAULT_MIN_SAVINGS;

  if (content.length <= max + minSavings) return content;

  const budget = Math.max(0, max - MARKER_BUDGET);
  const headLen = Math.floor(budget * headRatio);
  const tailLen = budget - headLen;
  const omitted = content.length - headLen - tailLen;

  return (
    content.slice(0, headLen) +
    `\n\n[... ${omitted.toLocaleString()} chars omitted by mantle to fit context ...]\n\n` +
    content.slice(content.length - tailLen)
  );
}
