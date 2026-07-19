// Pre-inference memory pack: on each user turn, query Englyph with the
// user's message as the semantic query, format top hits as a recalled-
// memory block for injection into the system prompt. Returns undefined
// when the turn is too thin to query and there's no prior context to
// fall back on; otherwise returns a markdown block ready to drop into
// the dynamic zone of the system prompt.
//
// The pack is kept short (top-9 with min_score floor) to stay under
// 1–2K tokens per turn. Scoring + min_score filter on the englyph side
// ensure irrelevant memories don't pollute context.

import * as chrono from "chrono-node";
import { getUserName } from "./prompt-builder.js";
import type { MessageContent } from "./providers/types.js";
import type { SessionMessage } from "./session.js";
import type { ToolRegistry } from "../tools/registry.js";

// ── Public types ──────────────────────────────────────────────────────

export interface PriorTurnTexts {
  priorAssistantText?: string;
  priorUserText?: string;
}

// ── Internal types ────────────────────────────────────────────────────

interface MemoryHit {
  drawer_id?: string;
  text: string;
  memory_type?: string;
  wing?: string;
  room?: string;
  score?: number;
  similarity?: number;
  // Evolving-memory substrate surfaced by englyph's enriched projection
  // (present-only; absent on legacy/dateless drawers and on the un-enriched
  // sample path). The pack renders dates for currency calibration and uses
  // thread/date to group evolving values; the currency flags arrive only when
  // a retrieval ran with navigate=true.
  date?: string;            // YYYY-MM-DD decision/session date
  thread?: string;          // thread_label — the evolving slot this value lives on
  thread_gist?: string;     // the thread's through-line
  shape?: string;           // memory_shape (stable_fact / contingent_value / …)
  state?: string;           // authored currency state when retracted/conditional
  areas?: string[];         // closed life-area tags
  is_thread_latest?: boolean;
  superseded?: boolean;
  stale?: string;           // upstream dependency moved after this was set
  depends_on?: string;
  consequent_value?: string;
}

// The navigation block englyph attaches to a navigate=true search: the route read
// the pack uses to compose its zones (T3) and surface currency state (T2).
interface PackNavigation {
  shape?: "evolution" | "semantic";
  dominant_hit?: boolean;
  top_thread?: string;
  top_thread_depth?: number;
  areas_present?: string[];
  currency_flags?: number;
  hint?: string;
}

type TemporalGrain = "day" | "week" | "month" | "year";

interface TemporalMeta {
  matchedPhrase: string;
  grain: TemporalGrain;
  dateStart: number; // YYYYMMDD inclusive
  dateEnd: number; // YYYYMMDD exclusive
}

interface TemporalSessionSummary {
  session_id: string;
  session_date: number;
  session_title: string;
  drawer_count: number;
}

// ── Temporal retrieval helpers ────────────────────────────────────────
//
// Parses temporal intent from the user's message (via chrono-node),
// converts to a YYYYMMDD int range, and calls `englyph_search_temporal`
// on the englyph side. Two response modes:
//   - session  → session-level enumeration (pure-temporal recap)
//   - semantic → drawer-level semantic rank within the date range
// Graceful no-op if no temporal language is detected, OR if temporal
// fires but returns zero results (false-positive mitigation — user
// says "fix the May bug" and chrono matches "May" as a month).

function parseTemporalIntent(text: string, now: Date = new Date()): TemporalMeta | null {
  const results = chrono.parse(text, now, { forwardDate: false });
  if (!results.length) return null;
  const r = results[0];
  const parsed = r.start.date();
  const grain = inferGrain(r.text);
  const [start, end] = toRange(parsed, grain);
  // Memories are about the past — a future-dated phrase ("tomorrow", "next
  // week") would fire a guaranteed-empty englyph round-trip every time it
  // appears. Skip when the whole window starts after today.
  const today = new Date(now);
  today.setHours(23, 59, 59, 999);
  if (start.getTime() > today.getTime()) return null;
  return {
    matchedPhrase: r.text,
    grain,
    dateStart: toYMD(start),
    dateEnd: toYMD(end),
  };
}

function inferGrain(phrase: string): TemporalGrain {
  const p = phrase.toLowerCase();
  if (p.includes("year")) return "year";
  if (p.includes("month")) return "month";
  if (p.includes("week")) return "week";
  return "day";
}

function toRange(d: Date, grain: TemporalGrain): [Date, Date] {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  if (grain === "day") {
    end.setDate(end.getDate() + 1);
  } else if (grain === "week") {
    // Week starts Monday. JS: 0=Sun, 1=Mon..
    const dow = start.getDay();
    const daysToMonday = dow === 0 ? 6 : dow - 1;
    start.setDate(start.getDate() - daysToMonday);
    end.setTime(start.getTime());
    end.setDate(end.getDate() + 7);
  } else if (grain === "month") {
    start.setDate(1);
    end.setTime(start.getTime());
    end.setMonth(end.getMonth() + 1);
  } else if (grain === "year") {
    start.setMonth(0, 1);
    end.setTime(start.getTime());
    end.setFullYear(end.getFullYear() + 1);
  }
  return [start, end];
}

function toYMD(d: Date): number {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function formatDateInt(yyyymmdd: number | undefined | null): string {
  if (!yyyymmdd) return "?";
  const y = Math.floor(yyyymmdd / 10000);
  const m = Math.floor((yyyymmdd % 10000) / 100);
  const d = yyyymmdd % 100;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Extract the topic content of the user text after stripping the
// temporal phrase. Used to decide whether englyph_search_temporal
// should run in session-enum mode (no topic) or semantic mode (topic
// present). The englyph side applies the same heuristic (2+ tokens =
// has-topic); we pre-filter here to avoid sending empty strings.
function extractTopicRemainder(text: string, matchedPhrase: string): string {
  let remainder = text;
  if (matchedPhrase) {
    remainder = remainder.split(matchedPhrase).join(" ");
  }
  return stripFiller(remainder);
}

// Decide whether a residual is substantive enough to drive semantic
// retrieval. The bare 2-word check used elsewhere is too loose for
// the temporal-residual case: recap queries like "what did I
// accomplish on April 11th" leave residue like "accomplish on" —
// 2 words, but only one content-bearing word + a preposition that
// stripFiller intentionally preserves for primary search.
//
// Embedding that residue against day-scoped drawers scores ~0
// against actual session content (the day was "phases tab debugging",
// not "accomplishing"), so semantic mode returns nothing and the user
// gets silence on a date that has plenty of memories.
//
// Require ≥2 words AND ≥2 of them being ≥4 chars long. This passes
// real topic residuals ("decide auth schema", "build pipeline last
// week") and rejects intent-verb-plus-preposition residue.
function isSubstantiveTopicRemainder(remainder: string): boolean {
  const words = remainder.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  const longEnough = words.filter((w) => w.replace(/[^\w]/g, "").length >= 4);
  return longEnough.length >= 2;
}

// ── Englyph result parsing ─────────────────────────────────────────────

function parseSearchHits(result: { content: string; isError?: boolean }): MemoryHit[] {
  if (result.isError) return [];
  try {
    const parsed = JSON.parse(result.content);
    return parsed?.results ?? [];
  } catch {
    return [];
  }
}

// Parse englyph_search_batch response. Shape: {results: [{results: [...]}, ...],
// _batch_timing: {embed_ms, n_queries}}. Returns one MemoryHit[] per input
// query, in input order. Logs the shared batch_embed_ms so attribution stays
// accurate when reading the pack-build log line.
function parseSearchBatchHits(
  result: { content: string; isError?: boolean },
): { perQuery: MemoryHit[][]; embedMs: number | null } {
  if (result.isError) return { perQuery: [], embedMs: null };
  try {
    const parsed = JSON.parse(result.content);
    const perQuery: MemoryHit[][] = (parsed?.results ?? []).map(
      (pq: { results?: MemoryHit[] }) => pq?.results ?? [],
    );
    const embedMs = parsed?._batch_timing?.embed_ms ?? null;
    return { perQuery, embedMs };
  } catch {
    return { perQuery: [], embedMs: null };
  }
}

// Parse a single englyph_search response into hits + the navigation block (route
// shape / dominant-hit / top thread / currency-flag count) present when the search
// ran with navigate=true. Same defensive shape as the other parsers.
function parseSearchResult(
  result: { content: string; isError?: boolean },
): { hits: MemoryHit[]; navigation: PackNavigation | null } {
  if (result.isError) return { hits: [], navigation: null };
  try {
    const parsed = JSON.parse(result.content);
    return { hits: parsed?.results ?? [], navigation: parsed?.navigation ?? null };
  } catch {
    return { hits: [], navigation: null };
  }
}

// Currency reveal for a hit. Englyph sets these flags only on evolving threads
// (depth ≥ 2) or moved dependencies, so a plain stable fact carries nothing —
// the marker appears exactly when the reader needs to not treat a value as
// current. Reveal, not suppress: the companion sees the value AND its status.
function currencyFlag(h: MemoryHit): string {
  // Only value-intrinsic, shape/state/dependency-gated signals — deliberately NOT
  // raw is_thread_latest. On a store without memory_shape (e.g. v10.2) a thread is a
  // narrative arc, not an evolving value-slot: "not the newest drawer" there doesn't
  // mean the value was superseded (an earlier beat in a story is still true), so
  // inferring superseded/current from position is a false signal. englyph sets
  // `superseded` only on evolving shapes, so gating on it keeps the marker honest;
  // "← current" is added by renderThreadGroup, where the group context earns it.
  if (h.state === "retracted") return "  — ⚠ removed, no longer true";
  if (h.stale) return `  — ⚠ may be outdated (${h.stale})`;
  if (h.superseded === true) return "  — ↑ superseded, a newer value exists";
  return "";
}

// Recalled memory content is UNTRUSTED text rendered into the prompt — the
// chat → archivist-`remember` → next-turn-prompt loop means anything a model
// (or an injected web page) once said can come back through here. A memory
// containing "\n# New Instructions" would otherwise render as a top-level
// heading indistinguishable from the pack's own structure. Collapse all
// newline runs to spaces so a hit/gist/title can only ever be one list line.
function inlineSanitize(s: string): string {
  return s.replace(/\s*\n+\s*/g, " ").trim();
}

// For intentionally multi-line englyph blocks (the formatted history trail):
// keep the line structure but defang markdown headings so recalled content
// can't fake the pack's own section headers.
function sanitizeMultiline(s: string): string {
  return s
    .split("\n")
    .map((l) => l.replace(/^\s*#+\s*/, ""))
    .join("\n");
}

function formatHitLine(h: MemoryHit): string {
  const type = inlineSanitize(h.memory_type ?? "?");
  const rawWing = h.wing && h.wing !== "unknown" ? inlineSanitize(h.wing) : "";
  const room = h.room && h.room !== "general" && h.room !== "unknown" ? `/${inlineSanitize(h.room)}` : "";
  const ctx = rawWing ? ` _(${rawWing}${room})_` : "";
  // Date leads the line: an evolving-memory pack is calibration-blind without
  // it — the reader can't tell a current fact from a months-old one. Omitted
  // when absent (dateless/legacy drawers, reminiscing sample) so the line stays
  // clean rather than carrying a "?".
  const date = h.date ? `${inlineSanitize(h.date)} · ` : "";
  return `- ${date}**[${type}]**${ctx} ${inlineSanitize(h.text ?? "")}${currencyFlag(h)}`;
}

const EVOLVING_SHAPES = new Set([
  "evolving_attribute",
  "contingent_value",
  "conditional_value",
]);

// A thread is worth collapsing into a dated value-trail only when it actually
// EVOLVES — some member is shape-flagged evolving, superseded, or retracted. On a
// store without shapes (v10.2) a multi-hit thread is just a narrative arc, so we
// leave it flat (dated) rather than framing it as "over time" with current /
// superseded markers we can't justify.
function isEvolvingGroup(group: MemoryHit[]): boolean {
  return group.some(
    (h) =>
      h.superseded === true ||
      h.state === "retracted" ||
      (h.shape !== undefined && EVOLVING_SHAPES.has(h.shape)),
  );
}

// Render an evolving entity's values as one tight dated mini-trail — oldest→newest
// under a gist header — instead of scattered lines, so the trajectory and the
// current value read at a glance. Per-line markers come from currencyFlag (shape-
// gated); the latest member is the current value, marked here since currencyFlag no
// longer infers current from position.
function renderThreadGroup(thread: string, group: MemoryHit[]): string[] {
  const sorted = [...group].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  const gist = sorted.find((h) => h.thread_gist)?.thread_gist;
  const header = gist
    ? `- **${inlineSanitize(gist)}** _(over time)_:`
    : `- **${inlineSanitize(thread)}** _(over time)_:`;
  return [
    header,
    ...sorted.map((h, i) => {
      const line = `  ${formatHitLine(h)}`;
      return i === sorted.length - 1 && currencyFlag(h) === "" ? `${line}  — ← current` : line;
    }),
  ];
}

// Group the topical hits by thread: a genuinely EVOLVING entity surfaced with
// multiple values renders as a dated mini-trail; everything else (narrative threads,
// singletons, untyped stores) renders inline in its original ranked position. No
// extra retrieval — this just organizes what was already fetched (the "lean" half of
// T3; the targeted full trail is pulled separately, above).
function renderGroupedHits(hits: MemoryHit[]): string[] {
  const byThread = new Map<string, MemoryHit[]>();
  for (const h of hits) {
    if (!h.thread) continue;
    const arr = byThread.get(h.thread);
    if (arr) arr.push(h);
    else byThread.set(h.thread, [h]);
  }
  const lines: string[] = [];
  const emitted = new Set<string>();
  for (const h of hits) {
    const group = h.thread ? byThread.get(h.thread) : undefined;
    if (group && group.length >= 2 && isEvolvingGroup(group)) {
      if (emitted.has(h.thread!)) continue;
      emitted.add(h.thread!);
      lines.push(...renderThreadGroup(h.thread!, group));
      continue;
    }
    lines.push(formatHitLine(h));
  }
  return lines;
}

// ── Query shaping ─────────────────────────────────────────────────────
//
// Conversational / filler words — removed before running the stripped-
// phrase query variant. Scoped tight: words that never carry retrieval
// signal on their own. Contractions are normalized (apostrophes stripped)
// so "don't" matches "dont".
//
// **IMPORTANT: we do NOT strip articles ("the", "a", "an") or short
// prepositions ("of", "to", "in", "on", "at", "for", "by").** Jina's
// phrase embeddings are structure-sensitive — "leverage the agent"
// scores 0.126 against a memory, "leverage agent" (same without "the")
// scores 0.055. Phrasal connectives hold embeddings together.
//
// NOT in this list (intentional): want/wanted/think/prefer — carry
// intent signal in companion memory.
const QUERY_STOPWORDS = new Set([
  // conjunctions + some long prepositions (keep short ones like "of", "to", "in")
  "and","or","but","if","because","into","onto","upon","across","against",
  "above","below","between","over","under","through","during","after","before",
  "since","until","while","from",
  // pronouns
  "i","me","my","mine","myself","you","your","yours","yourself","youre","youve",
  "we","our","ours","us","ourselves","he","him","his","himself","she","her",
  "hers","herself","it","its","itself","they","them","their","theirs",
  // auxiliary / state verbs + contractions (these don't anchor phrases)
  "am","be","been","being","do","does","did","doing","done","dont","doesnt",
  "didnt","have","has","had","having","havent","hasnt","hadnt","can","cant",
  "could","couldnt","will","wont","would","wouldnt","should","shouldnt","may",
  "might","must","shall",
  // filler adverbs / adjectives / content-light words
  "about","again","also","already","always","actually","basically","barely",
  "definitely","even","ever","every","everything","exactly","fairly","honestly",
  "just","kinda","kind","literally","maybe","much","many","more","most","never",
  "nice","now","only","pretty","probably","really","right","same","some","sort",
  "sorta","still","such","sure","that","there","these","this","those","very",
  "well","what","whats","whatever","when","where","which","whichever","while","who","whom",
  "whose","why","how","however","yeah","yes","okay","ok","cool","good","bad","nope",
  "oh","ohh","ooh","ah","ahh","uh","um","hmm","huh","eh","man","dude","bro",
  "gosh","damn","thats","whatd","whatre","whatll","theres","gonna","wanna","gotta",
  "shes","hes","its","im","ive","id","ill","youd","youll","theyd","theyll",
  // conversational prefix verbs (often open-the-sentence)
  "say","saying","said","tell","telling","told","show","showing","showed","seen",
  "get","getting","got","gotten","go","going","went","gone","know","knows","knew",
  "think","thinks","thinking","thought","mean","means","meant","look","looking",
  "looked","make","makes","made","making","take","takes","took","taken","taking",
  "let","lets","leave","leaves","left","need","needs","needed","needing","want",
  "wants","wanted","like","likes","liked","liking","hey","hi","hello",
  // commonly meaningless-on-their-own
  "thing","things","stuff","way","ways","time","times","kind","type","part",
  "parts","place","people","person","day","days","regarding","favorite","thanks","thx",
  // aux state verbs that rarely anchor phrases
  "is","are","was","were",
]);

// Strip conversational stopwords from a query while preserving word
// order and phrase structure. Jina single-word queries suffer from
// word-sense ambiguity ("leverage" → financial/mechanical sense, not
// the user's "use fully" sense), scoring ~0 against relevant memories.
// Phrases disambiguate. This keeps a phrase-level query variant that
// filters filler while leaving the actual topic phrase intact.
//
// Example: "you're doing good. but you still haven't gotten leverage
// the agent working" → "doing good haven't gotten leverage agent
// working" (preserves "leverage ... agent" collocation).
function stripFiller(text: string): string {
  return text
    .split(/\s+/)
    .filter((w) => {
      const normalized = w.toLowerCase().replace(/[^\w]/g, "");
      if (!normalized) return false;
      if (QUERY_STOPWORDS.has(normalized)) return false;
      return true;
    })
    .join(" ")
    .trim();
}

// Split a user message into clauses on major punctuation. Multi-clause
// conversational messages ("oh man the memories hit. hey whats context
// is king") mix unrelated topics — running each clause as its own sub-
// query isolates the topic signal from surrounding filler.
//
// Two caps to keep fan-out bounded on long multi-clause turns (one
// embed call ≈ 95ms, and embeds serialize through the single Jina
// model — so 6 clauses × 2 variants = 12 sequential embeds = ~1.1s):
//
//   MIN_CLAUSE_CHARS — drops trivially short clauses ("perfect",
//     ") Does that make sense") that can't carry topic signal on their
//     own (Jina single-token queries suffer word-sense ambiguity).
//   MAX_CLAUSES — pick the longest N when over budget. Long clauses
//     carry more topic content than short conversational fragments.
//     Sorts by length then re-sorts to preserve textual order so logs
//     read naturally.
const MIN_CLAUSE_CHARS = 12;
const MAX_CLAUSES = 3;
function splitIntoClauses(text: string): string[] {
  const all = text
    .split(/[.!?;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_CLAUSE_CHARS);
  if (all.length <= MAX_CLAUSES) return all;
  return all
    .map((s, i) => ({ s, i, len: s.length }))
    .sort((a, b) => b.len - a.len)
    .slice(0, MAX_CLAUSES)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s);
}

// Template HyDE — generate memory-shaped variants of a user query
// without invoking an LLM.
//
// Authored memories follow a strict third-person, user-referential
// framing (Englyph's ingest authors "<user> wants...", "<user> thinks...",
// "<user> prefers...", "<user> is..."). User queries
// arrive in first-person, conversational shape — "what's my approach
// to X", "I want to Y" — so similarity matches against authored
// memories are diluted by the framing gap.
//
// We bridge that gap deterministically (no LLM): strip filler from
// the user's text to get a topic phrase, then reframe the topic
// inside each of the 4 speech-act voices. The resulting queries are
// grammatically rough but embed close to authored-memory framing,
// so Jina matches them better than the raw user phrasing.
//
// All 4 voices fire because each maps to a different memory type
// (want / preference / opinion / observation), and we don't know
// which type the user is implicitly asking about. Cost is 4 extra
// queries per user-text source; under englyph_search_batch the
// latency impact is negligible (~95ms total batched embed).
//
// The user's name is the framing prefix authored memories carry (Englyph's
// ingest writes "<user> wants...", "<user> prefers...", etc.), so the writer
// and reader vocabulary share it by construction. Resolved live from the
// profile (getUserName) rather than hardcoded — falls back to "the user".
const HYDE_TEMPLATES: Array<(topic: string) => string> = [
  (topic) => `${getUserName()} wants ${topic}`,
  (topic) => `${getUserName()} prefers ${topic}`,
  (topic) => `${getUserName()} thinks ${topic}`,
  (topic) => `${getUserName()} is ${topic}`,
];

// Substantiveness gate: require HYDE_MIN_TOPIC_WORDS+ content words
// in the topic phrase before firing HyDE. Empirically calibrated:
//
//   - 3 or fewer words ("vendor-in-place approach sounds") → the
//     framing prefix ("<user> wants ", "<user> prefers ", ...) dominates
//     the embedding and the query matches *any* memory carrying that
//     type-vocabulary regardless of topic.
//   - 4 words is borderline — caught system markers like
//     "[Request interrupted by user]" (request/interrupted/by/user
//     all survive stripping) which then surface generic preferences.
//   - 5+ words gives the topic enough vocabulary to compete with the
//     framing tokens, and HyDE genuinely lifts topic-relevant scores
//     instead of pulling in type-match noise.
//
// Bare-fact terse turns ("tell me more", "go ahead", "ran it") fall
// under this gate naturally because their stripped form has ~0
// content words after filler removal.
const HYDE_MIN_TOPIC_WORDS = 5;

function templateHydeVariants(text: string): string[] {
  const topic = stripFiller(text);
  if (!topic || topic.length < 8) return [];
  if (topic.split(/\s+/).filter(Boolean).length < HYDE_MIN_TOPIC_WORDS) return [];
  return HYDE_TEMPLATES.map((t) => t(topic));
}

// Cap query text length to keep Jina's embedding focused. Long assistant
// responses dilute the topic across many tokens; first ~600 chars
// captures the topical opening (and is usually where the agent stated
// what it's discussing). Short text passes through untouched.
//
// Backs off one UTF-16 code unit if the cut would land mid-surrogate-
// pair so we don't ship a lone surrogate downstream — the MCP write
// boundary scrubs them as a safety net, but losing one half of an
// emoji silently is a less-helpful query than the same query without
// the trailing emoji at all.
function windowForQuery(text: string, max: number = 600): string {
  if (text.length <= max) return text;
  let end = max;
  const cu = text.charCodeAt(end - 1);
  if (cu >= 0xD800 && cu <= 0xDBFF) end -= 1;
  return text.slice(0, end);
}

// Merge hits from multiple searches. Dedupe by drawer_id (or text
// when id is missing). Keep the max score seen for any given drawer,
// sort descending, take top K.
function mergeHits(results: MemoryHit[][], topK: number): MemoryHit[] {
  const byKey = new Map<string, MemoryHit>();
  for (const set of results) {
    for (const h of set) {
      const key = h.drawer_id || h.text;
      if (!key) continue;
      const prev = byKey.get(key);
      const hScore = h.score ?? h.similarity ?? 0;
      if (!prev) {
        byKey.set(key, h);
      } else {
        const prevScore = prev.score ?? prev.similarity ?? 0;
        if (hScore > prevScore) byKey.set(key, h);
      }
    }
  }
  return [...byKey.values()]
    .sort((a, b) => (b.score ?? b.similarity ?? 0) - (a.score ?? a.similarity ?? 0))
    .slice(0, topK);
}

// ── Prior-turn helpers ────────────────────────────────────────────────

// Pull text from a session message's content blocks. Skips tool_use,
// tool_result, thinking, and attachments — only "text" content carries
// conversational signal we'd want to query memory with.
function extractTextContent(content: MessageContent[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// Find the most recent prior assistant text + prior user text from the
// session, skipping the just-appended current user message and any
// tool_result-only intermediaries from a multi-step tool chain. Returns
// the freshest text-bearing message of each role from before this turn.
//
// Walking backwards is key: in a tool-using turn the session looks like
// [user_input, asst+tool_use, user(tool_result), asst+tool_use, ...,
//  asst_final_text, user_new]. We want asst_final_text and the
// user_input that started that chain — not the tool_result echoes.
export function findPriorTurnTexts(messages: SessionMessage[]): PriorTurnTexts {
  let priorAssistantText: string | undefined;
  let priorUserText: string | undefined;
  for (let i = messages.length - 2; i >= 0; i--) {
    const msg = messages[i];
    const text = extractTextContent(msg.content);
    if (!text) continue;
    if (msg.role === "assistant" && !priorAssistantText) priorAssistantText = text;
    else if (msg.role === "user" && !priorUserText) priorUserText = text;
    if (priorAssistantText && priorUserText) break;
  }
  return { priorAssistantText, priorUserText };
}

// ── Public entry point ────────────────────────────────────────────────

// Whole-pack wall-clock budget. The pack runs pre-inference while holding the
// agent lock and inherits the MCP layer's 600s call ceiling, so a wedged Englyph
// daemon would freeze the turn for minutes. Race the work against this budget:
// on overrun the pack resolves to `undefined` (no pack) and the turn proceeds.
const MEMORY_PACK_BUDGET_MS = 4000;

export async function buildMemoryPack(
  registry: ToolRegistry,
  userText: string,
  agentId: string,
  context?: PriorTurnTexts,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), MEMORY_PACK_BUDGET_MS);
  // Compose the internal budget with the caller's /stop signal so a user cancel
  // also unwinds the pack. Threaded into the englyph ctx below for cancellation,
  // and raced here so the turn never blocks past the budget regardless of
  // whether the MCP client honors the signal mid-call.
  const packSignal = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;
  const deadline = new Promise<undefined>((resolve) => {
    if (packSignal.aborted) return resolve(undefined);
    packSignal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
  try {
    return await Promise.race([
      runMemoryPack(registry, userText, agentId, context, packSignal),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runMemoryPack(
  registry: ToolRegistry,
  userText: string,
  agentId: string,
  context: PriorTurnTexts | undefined,
  packSignal: AbortSignal,
): Promise<string | undefined> {
  const text = userText.trim();
  const hasContext = !!(context?.priorAssistantText || context?.priorUserText);
  // Skip pack entirely only when the user turn is trivially short AND
  // there's no prior context to fall back on. "ok" / "go ahead" alone →
  // skip. "go ahead" after the agent just discussed embedders → still
  // build a pack, using the prior assistant turn as the query material.
  if (text.length < 4 && !hasContext) return undefined;

  const t0 = performance.now();
  const PACK_LIMIT = 9;
  // Reminiscing sizing: always include some ambient-history color, but
  // boost when primary retrieval returns nothing so the pack isn't
  // barren. Gives the agent material for "that reminds me" even on
  // empty turns.
  const REMINISCING_WHEN_TOPICAL = 3;
  const REMINISCING_WHEN_EMPTY = 6;

  // ── Stage 1: build query set — multi-source, multi-variant fan-out ───
  // Conversational phrasings dilute the query vector across filler words,
  // and multi-clause queries mix unrelated topics. We fan out across:
  //
  // CURRENT USER TURN — three variant tiers:
  //   1. Full user text (semantic intent, may miss keywords)
  //   2. Per-clause variants (split on .!?;) — isolates each sentence
  //      so filler in one doesn't dilute the topic in another
  //   3. Stopword-stripped full + each stripped clause — preserves
  //      phrase structure (keeps "the", "of", "to" — those anchor
  //      Jina's phrase matching) while dropping filler/fluff
  //
  // PRIOR CONTEXT (when available) — additional sources:
  //   4. Prior assistant response (windowed to 600 chars, full +
  //      stripped) — closer to memory framing than user-speak, and
  //      essential for "tell me more" / "go ahead" follow-ups where
  //      the current user turn carries no topical signal
  //   5. Prior user turn (full + stripped) — preserves topic continuity
  //      across short conversational ping-pong
  //
  // Prior-context sources skip the per-clause split: assistant prose is
  // paragraph-structured rather than multi-clause, and prior-user is
  // contextual not primary, so we keep its fan-out smaller.
  //
  // Stripped variants below MIN_STRIPPED_CHARS are skipped: when filler
  // removal leaves a 1-2 word fragment ("sense", "ahead start"), Jina
  // can't disambiguate it (single-token word-sense ambiguity), so the
  // query just burns an embed call without contributing signal.
  const MIN_STRIPPED_CHARS = 8;
  // Window EVERY embed-query source. A 20KB paste otherwise becomes a 20KB
  // embed query (and its longest clauses become more of them) — the exact
  // latency-variance failure mode this pack was designed to avoid. The full
  // unwindowed text is still used for temporal parsing + the skip check.
  const queryText = windowForQuery(text, 600);
  const queries = new Set<string>();
  if (queryText.length >= 4) {
    // NOTE: the raw query text itself is deliberately NOT added — the
    // navigated primary search below embeds exactly that string, so adding
    // it here embedded the same text twice (~95ms wasted per turn).
    const stripped = stripFiller(queryText);
    if (stripped && stripped !== queryText && stripped.length >= MIN_STRIPPED_CHARS) {
      queries.add(stripped);
    }
    for (const c of splitIntoClauses(queryText)) {
      if (c !== queryText) queries.add(c);
      const cs = stripFiller(c);
      if (cs && cs !== c && cs.length >= MIN_STRIPPED_CHARS) queries.add(cs);
    }
    // Memory-shaped framings (template HyDE) of the current turn's
    // topic. Skipped for prior-assistant text because it's already
    // written in memory-shaped voice; applied to prior-user text
    // below for the same framing-mismatch reason as current-user.
    for (const v of templateHydeVariants(queryText)) queries.add(v);
  }
  if (context?.priorAssistantText) {
    const windowed = windowForQuery(context.priorAssistantText, 600);
    queries.add(windowed);
    const stripped = stripFiller(windowed);
    if (stripped && stripped !== windowed && stripped.length >= MIN_STRIPPED_CHARS) {
      queries.add(stripped);
    }
  }
  if (context?.priorUserText) {
    const priorUser = windowForQuery(context.priorUserText, 600);
    queries.add(priorUser);
    const stripped = stripFiller(priorUser);
    if (stripped && stripped !== priorUser && stripped.length >= MIN_STRIPPED_CHARS) {
      queries.add(stripped);
    }
    for (const v of templateHydeVariants(priorUser)) queries.add(v);
  }

  const queryList = [...queries];
  // Englyph tools are per-agent; thread agentId through every registry
  // call. sessionId="memory-pack" is a marker for the englyph side that
  // distinguishes pack-builder dispatches from in-loop tool calls.
  const ctx = { agentId, sessionId: "memory-pack", signal: packSignal };

  // ── Stage 2: parallel englyph fan-out ─────────────────────────────────
  // The three independent calls — batch search (semantic), temporal
  // search (date-window), and reminiscing sample — all fire in one wave.
  // They were previously sequential `await`s; that meant temporal added
  // ~80ms after batch returned, and reminiscing added another ~30ms
  // after that. With Promise.all, total wall-clock = max(individual)
  // instead of sum, saving ~80–110ms on temporal-bearing turns and
  // ~30ms on every turn.
  //
  // Reminiscing is fired speculatively at REMINISCING_WHEN_EMPTY (6) and
  // trimmed to REMINISCING_WHEN_TOPICAL (3) below if primary retrieval
  // came back non-empty. The extra 3 chroma rows are essentially free
  // since englyph_sample_drawers does no embedding — pure metadata
  // sample — and the latency saved by parallelizing dwarfs the cost.
  //
  // Each catch returns null so Promise.all doesn't reject; downstream
  // null-checks suppress empty sections gracefully (matches the
  // pre-extraction try/catch behavior).
  const temporalMeta = parseTemporalIntent(text);

  // With the raw text routed through the navigated primary search instead,
  // a short single-clause turn can leave the variant set empty — skip the
  // batch call rather than firing it with zero queries.
  const batchPromise = queryList.length > 0
    ? registry
        .execute(
          "englyph_search_batch",
          {
            queries: queryList,
            n_results: PACK_LIMIT,
            min_score: 0.10,
          },
          ctx,
        )
        .catch((err) => {
          console.warn(`[MANTLE:memory-pack] batch search threw:`, err);
          return null;
        })
    : Promise.resolve(null);

  const temporalPromise: Promise<{ content: string; isError?: boolean } | null> = temporalMeta
    ? (() => {
        const topicRem = extractTopicRemainder(text, temporalMeta.matchedPhrase);
        // Pass the residual only if it's substantive — otherwise force
        // session mode by sending empty. Recap-shaped queries ("what
        // did I accomplish on X") leave intent-verb residue that
        // semantic mode can't make use of and would return zero hits.
        const temporalQuery = isSubstantiveTopicRemainder(topicRem) ? topicRem : "";
        return registry
          .execute(
            "englyph_search_temporal",
            {
              date_start: temporalMeta.dateStart,
              date_end: temporalMeta.dateEnd,
              query: temporalQuery,
              max_results: 4,
            },
            ctx,
          )
          .catch((err) => {
            console.warn(`[MANTLE:memory-pack] temporal search threw:`, err);
            return null;
          });
      })()
    : Promise.resolve(null);

  const reminiscingPromise = registry
    .execute(
      "englyph_sample_drawers",
      {
        n: REMINISCING_WHEN_EMPTY, // speculative max — trim later if not needed
        // bias away from observations — less voice, less reminisce-worthy
        exclude_types: ["observation"],
      },
      ctx,
    )
    .catch((err) => {
      console.warn(`[MANTLE:memory-pack] sample threw:`, err);
      return null;
    });

  // Primary navigated search on the user's actual turn — runs in parallel with the
  // batch. The batch fans out variants for breadth (no per-query analysis); this one
  // call carries navigate=true, so its hits arrive currency-annotated
  // (is_thread_latest / stale / superseded) and it returns a navigation block (route
  // shape / top thread / currency flags) the pack composes from. Skipped on a
  // too-thin turn — the batch's prior-context queries still cover those. .catch→null
  // like the others so Promise.all never rejects.
  const primaryPromise: Promise<{ content: string; isError?: boolean } | null> =
    queryText.length >= 4
      ? registry
          .execute(
            "englyph_search",
            { query: queryText, n_results: PACK_LIMIT, min_score: 0.10, navigate: true },
            ctx,
          )
          .catch((err) => {
            console.warn(`[MANTLE:memory-pack] primary search threw:`, err);
            return null;
          })
      : Promise.resolve(null);

  const [batchRaw, primaryRaw, temporalRaw, reminiscingRaw] = await Promise.all([
    batchPromise,
    primaryPromise,
    temporalPromise,
    reminiscingPromise,
  ]);

  // ── Stage 2a: process batch + primary results ───────────────────────
  let queryResults: MemoryHit[][] = [];
  let batchEmbedMs: number | null = null;
  if (batchRaw) {
    const parsed = parseSearchBatchHits(batchRaw);
    queryResults = parsed.perQuery;
    batchEmbedMs = parsed.embedMs;
  }
  // Primary (navigated) hits lead the merge — the user's actual-query results rank
  // first, and they carry the currency flags the batch hits lack. `navigation` drives
  // the zone routing (T3).
  const navResult = primaryRaw
    ? parseSearchResult(primaryRaw)
    : { hits: [] as MemoryHit[], navigation: null as PackNavigation | null };
  const navigation = navResult.navigation;
  const topical = mergeHits([navResult.hits, ...queryResults], PACK_LIMIT);
  // Splice currency annotations from the primary search onto whichever merged object
  // won dedup (mergeHits keeps the higher-scored copy, which can be an un-annotated
  // batch hit). Present-only (??=): a no-op when the store carries no currency signal.
  if (navResult.hits.length) {
    const byId = new Map<string, MemoryHit>();
    for (const h of navResult.hits) if (h.drawer_id) byId.set(h.drawer_id, h);
    for (const h of topical) {
      const p = h.drawer_id ? byId.get(h.drawer_id) : undefined;
      if (!p) continue;
      h.is_thread_latest ??= p.is_thread_latest;
      h.superseded ??= p.superseded;
      h.stale ??= p.stale;
      h.state ??= p.state;
      h.thread ??= p.thread;
      h.date ??= p.date;
      // shape + gist drive the evolving-thread grouping/rendering — without
      // them a batch hit that won dedup rendered an evolving thread flat.
      h.shape ??= p.shape;
      h.thread_gist ??= p.thread_gist;
    }
  }

  // ── Stage 2b: FTS5 fallback (sequential, only when topical empty) ───
  // Last resort for queries where even the decomposed terms didn't clear
  // the 0.10 floor. Takes anything with positive score — FTS5-only hits
  // that rode into the pool at similarity=0 get surfaced via metadata.
  // Kept sequential because it only fires on the slow path (empty
  // topical), and the fallback's input depends on knowing topical was
  // empty — speculatively running it in parallel would burn embed time
  // on every turn for the rare "main path failed" case.
  let fallback: MemoryHit[] = [];
  // Same ≥4-char floor the primary path gates on — an attachment-only turn
  // (empty/near-empty queryText) used to fire a junk FTS query here.
  if (topical.length === 0 && queryText.trim().length >= 4) {
    try {
      const r = await registry.execute(
        "englyph_search",
        {
          query: queryText,
          n_results: PACK_LIMIT,
          min_score: 0,
        },
        ctx,
      );
      fallback = parseSearchHits(r).filter(
        (h) => (h.score ?? 0) > 0 || (h.similarity ?? 0) > 0,
      );
    } catch (err) {
      console.warn(`[MANTLE:memory-pack] fallback search threw:`, err);
    }
  }

  const primary = [...topical, ...fallback];

  // ── Stage 2c: process temporal results ───────────────────────────────
  let temporalSessions: TemporalSessionSummary[] = [];
  let temporalHits: MemoryHit[] = [];
  let temporalMode: "session" | "semantic" | null = null;
  if (temporalMeta && temporalRaw && !temporalRaw.isError) {
    try {
      const parsed = JSON.parse(temporalRaw.content) as {
        mode?: "session" | "semantic";
        results?: Array<Record<string, unknown>>;
      };
      temporalMode = parsed?.mode ?? null;
      if (temporalMode === "session") {
        temporalSessions = (parsed.results ?? []) as unknown as TemporalSessionSummary[];
      } else if (temporalMode === "semantic") {
        temporalHits = (parsed.results ?? []).map((h) => ({
          drawer_id: h.drawer_id as string | undefined,
          text: (h.text as string) ?? "",
          memory_type: h.memory_type as string | undefined,
          wing: h.wing as string | undefined,
          room: h.room as string | undefined,
          score: h.score as number | undefined,
          date: h.date as string | undefined,
        }));
      }
    } catch {
      // Malformed JSON from temporal — silently fall through to no-temporal
    }
  }
  const hasTemporal = temporalSessions.length > 0 || temporalHits.length > 0;

  // ── Stage 2d: process reminiscing — trim to needed count ────────────
  const reminiscingCount =
    primary.length === 0 ? REMINISCING_WHEN_EMPTY : REMINISCING_WHEN_TOPICAL;
  const reminiscing: MemoryHit[] = reminiscingRaw
    ? parseSearchHits(reminiscingRaw).slice(0, reminiscingCount)
    : [];

  // ── Stage 2e: targeted history pull ─────────────────────────────────
  // The "targeted" half of T3: pull the full dated trail for the top thread ONLY
  // when the turn lands on an evolving entity AND something looks stale/superseded
  // (currency_flags > 0) — exactly the case where the companion needs the trail to
  // state the current value and not an overtaken one. Otherwise the in-pack grouping
  // is enough and the agent can recall_history on demand. One extra (sequential)
  // call, only on those turns; budget-tight; degrades to no zone on any error.
  let historyTrail = "";
  if (
    navigation?.shape === "evolution" &&
    (navigation.currency_flags ?? 0) > 0 &&
    navigation.top_thread
  ) {
    try {
      const r = await registry.execute(
        "englyph_recall_thread",
        { thread_label: navigation.top_thread, budget_tokens: 1200 },
        ctx,
      );
      if (r && !r.isError) {
        const parsed = JSON.parse(r.content);
        // sanitizeMultiline: the trail is recalled content — strip heading
        // markers so it can't fake the pack's own section structure.
        if (parsed?.formatted) historyTrail = sanitizeMultiline(String(parsed.formatted).trim());
      }
    } catch (err) {
      console.warn(`[MANTLE:memory-pack] history pull threw:`, err);
    }
  }

  const elapsed = Math.round(performance.now() - t0);

  // ── Stage 3: assemble pack ──────────────────────────────────────────
  if (primary.length === 0 && reminiscing.length === 0 && !hasTemporal && !historyTrail) {
    // Distinguish "store is reachable but had nothing" from "couldn't reach the
    // store at all." Each englyph call degrades to null (threw) or an isError
    // result (e.g. daemon down → "Unknown tool"); if EVERY attempted call
    // failed, we never actually looked — emitting the "nothing relevant, don't
    // search more" sentinel would make the companion confidently claim it
    // checked when memory was merely unavailable. batch + reminiscing fire on
    // every pack, so a clean response from any call means englyph was reachable.
    const englyphReachable =
      (!!batchRaw && !batchRaw.isError) ||
      (!!primaryRaw && !primaryRaw.isError) ||
      (!!temporalRaw && !temporalRaw.isError) ||
      (!!reminiscingRaw && !reminiscingRaw.isError);
    if (!englyphReachable) {
      console.log(`[MANTLE:memory-pack] englyph unreachable this turn — no pack injected (${elapsed}ms)`);
      return undefined;
    }
    console.log(
      `[MANTLE:memory-pack] 0 topical, 0 temporal, 0 reminiscing for "${text.slice(0, 60)}" (${elapsed}ms)`,
    );
    return [
      "# Recalled Memories",
      "",
      "Nothing relevant surfaced for this turn.",
    ].join("\n");
  }

  const lines: string[] = [];

  // Targeted history zone (leads when present): the full dated trail for an evolving
  // entity the turn touches. The entity is excluded from the flat list below so it
  // appears once, not twice.
  if (historyTrail) {
    lines.push("# Current State & History");
    lines.push("");
    lines.push("Dated trail — the last entry is the current value; earlier ones are superseded.");
    lines.push("");
    lines.push(historyTrail);
    lines.push("");
  }

  // Flat topical set, minus the entity already shown in full in the history zone.
  const recalledHits = historyTrail
    ? primary.filter((h) => h.thread !== navigation?.top_thread)
    : primary;
  if (recalledHits.length > 0) {
    lines.push("# Recalled Memories");
    lines.push("");
    lines.push(
      fallback.length > 0
        ? `${recalledHits.length} surfaced for this turn (topical: ${topical.length}, keyword-fallback: ${fallback.length}).`
        : `${recalledHits.length} surfaced for this turn.`,
    );
    lines.push("");
    lines.push(...renderGroupedHits(recalledHits));
  }

  // Temporal section (between topical and reminiscing). Rendered only
  // when temporal intent was detected AND returned data. Empty results
  // from false-positive parses (e.g. bare "May") are silently
  // suppressed so the pack doesn't carry an empty header.
  if (hasTemporal && temporalMeta) {
    if (lines.length > 0) lines.push("");
    const rangeLabel =
      temporalMeta.grain === "day"
        ? formatDateInt(temporalMeta.dateStart)
        : `${temporalMeta.grain} of ${formatDateInt(temporalMeta.dateStart)}`;
    lines.push(`# Temporal — from "${temporalMeta.matchedPhrase}" (${rangeLabel})`);
    lines.push("");
    if (temporalMode === "session") {
      lines.push(
        "Sessions in that window — what the user was doing then, not records to read back. Weigh which were the big ones; don't read titles, dates, or drawer counts aloud.",
      );
      lines.push("");
      for (const s of temporalSessions) {
        const date = formatDateInt(s.session_date);
        const n = s.drawer_count ?? 0;
        lines.push(
          `- **[${date}]** _${inlineSanitize(s.session_title || "(untitled)")}_ (${n} drawer${n !== 1 ? "s" : ""})`,
        );
      }
    } else {
      lines.push(
        `${temporalHits.length} memor${temporalHits.length !== 1 ? "ies" : "y"} matching that topic within the window (overlap with Recalled Memories above is corroboration).`,
      );
      lines.push("");
      for (const h of temporalHits) lines.push(formatHitLine(h));
    }
  }

  if (reminiscing.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("# Reminiscing — from your shared history");
    lines.push("");
    lines.push("Older memories, not tied to this turn — surfaced for color and callbacks.");
    lines.push("");
    for (const h of reminiscing) lines.push(formatHitLine(h));
  }

  const embedNote = batchEmbedMs !== null ? ` batch_embed=${Math.round(batchEmbedMs)}ms` : "";
  const temporalNote = temporalMeta
    ? ` temporal=${temporalMode ?? "?"}:${temporalSessions.length + temporalHits.length}/${temporalMeta.matchedPhrase}`
    : "";
  console.log(
    `[MANTLE:memory-pack] topical=${topical.length} fallback=${fallback.length}${temporalNote} reminiscing=${reminiscing.length} nav=${navigation?.shape ?? "-"} queries=${queryList.length}${embedNote} for ${agentId} in ${elapsed}ms — "${text.slice(0, 60)}"`,
  );

  return lines.join("\n");
}
