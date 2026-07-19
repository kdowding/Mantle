// Best-effort repair of malformed tool-call argument JSON.
//
// Models — especially Grok and local GGUF runtimes whose grammar
// constraints are loose — routinely emit tool arguments that aren't quite
// valid JSON: the object wrapped in a ```json fence, prefixed with prose
// ("Here are the arguments:"), trailed by an explanation after the closing
// brace, smart quotes instead of straight ones, HTML-entity-encoded quotes,
// or a stray trailing comma. The agent loop calls this on a `JSON.parse`
// failure BEFORE giving up, so a recoverable malformation costs zero
// iterations instead of one wasted round-trip.
//
// Deliberately conservative — every candidate must parse to a plain JSON
// OBJECT (not an array, not a scalar). Anything we can't confidently
// recover returns null, and the loop falls through to tagging the call with
// `_parseError` so registry.execute surfaces the real "your JSON was
// malformed" message (which is far more actionable than a phantom "missing
// required parameter"). We do NOT attempt to fix unescaped quotes inside
// string values — that path is ambiguous and better handled by letting the
// model see its raw text and re-emit.

export interface RepairResult {
  input: Record<string, unknown>;
  // false when the raw text parsed as-is (caller passed something already
  // valid); true when a transform was needed. Lets the loop log only real
  // repairs.
  repaired: boolean;
}

export function repairToolArgs(raw: string): RepairResult | null {
  if (typeof raw !== "string") return null;

  // Idempotent: if it already parses, report repaired:false. The loop only
  // calls us after a failed parse, but keeping this safe to call directly
  // makes it testable in isolation.
  const direct = tryParseObject(raw);
  if (direct) return { input: direct, repaired: false };

  const s = raw.trim();
  const candidates: string[] = [];

  // 1) Pull the body out of a Markdown code fence (```json … ``` / ``` … ```).
  const fence = s.match(/```(?:json|js|javascript)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());

  // 2) Slice from the first "{" to the last "}" — strips a leading label and
  //    trailing prose after the object, Grok's single most common malformation.
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(s.slice(first, last + 1));

  // 3) The trimmed whole string, so the char-level repairs below still run
  //    when there's no fence and no surrounding prose.
  candidates.push(s);

  for (const base of candidates) {
    for (const variant of buildVariants(base)) {
      const parsed = tryParseObject(variant);
      if (parsed) return { input: parsed, repaired: true };
    }
  }

  return null;
}

// Cumulative char-level repairs, each tried in turn. Order matters: quote
// normalization before entity decode before trailing-comma removal.
function buildVariants(base: string): string[] {
  const out: string[] = [base];

  // Smart/curly quotes → straight quotes.
  const straight = base
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
  out.push(straight);

  // The handful of HTML entities models emit for quotes/brackets/ampersands.
  const deEntity = straight
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  out.push(deEntity);

  // Trailing commas before a closing brace/bracket.
  out.push(deEntity.replace(/,\s*([}\]])/g, "$1"));

  return out;
}

function tryParseObject(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v = JSON.parse(t);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    // not recoverable at this variant
  }
  return null;
}
