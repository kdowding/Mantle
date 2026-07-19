/**
 * Shared model-pull engine. Resolves a HuggingFace spec (full URL, or
 * `org/repo[:quant]`, or `org/repo:file.gguf`) to one or more GGUF files,
 * streams them to `<modelsDir>/models/`, and registers the result.
 *
 * Drives BOTH the REST pull endpoint (src/server/api.ts via LocalModelManager)
 * and `mantle pull` (src/cli.ts) — the CLI delegates to pullModel() and just
 * renders the onProgress stream as its console readout, so the download +
 * register logic lives here only and can't drift between the two paths.
 *
 * Dependency-free beyond fs/path + the registry.
 */

import { existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { basename, resolve } from "path";
import { modelsWeightsDir, upsertModel } from "./registry.js";

export function fmtBytes(n: number): string {
  if (!n || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function extractQuant(file: string): string | undefined {
  const m = basename(file).match(/\b(IQ\d[\w]*|Q\d[\w]*|BF16|FP16|FP32|F16|F32)\b/i);
  return m ? m[1].toUpperCase() : undefined;
}

export function uniqueQuants(ggufs: string[]): string[] {
  const qs = new Set<string>();
  for (const f of ggufs) {
    const q = extractQuant(f);
    if (q) qs.add(q);
  }
  return [...qs].sort();
}

// Split GGUF naming: `<base>-00001-of-00003.gguf`. llama.cpp loads the whole
// set when pointed at the first part.
function splitMatch(name: string): { base: string; idx: number; total: number } | null {
  const m = basename(name).match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
  if (!m) return null;
  return { base: m[1], idx: parseInt(m[2], 10), total: parseInt(m[3], 10) };
}

function expandSplit(file: string, allGgufs: string[]): string[] {
  const sm = splitMatch(file);
  if (!sm) return [file];
  const fromListing = allGgufs.filter((f) => {
    const m = splitMatch(f);
    return m && m.base === sm.base && m.total === sm.total;
  });
  if (fromListing.length === sm.total) return fromListing.slice().sort();
  const parts: string[] = [];
  for (let i = 1; i <= sm.total; i++) {
    parts.push(`${sm.base}-${String(i).padStart(5, "0")}-of-${String(sm.total).padStart(5, "0")}.gguf`);
  }
  return parts;
}

function pickRepresentatives(candidates: string[]): string[] {
  const seenBase = new Set<string>();
  const out: string[] = [];
  for (const f of candidates) {
    const sm = splitMatch(f);
    if (sm) {
      if (sm.idx !== 1 || seenBase.has(sm.base)) continue;
      seenBase.add(sm.base);
    }
    out.push(f);
  }
  return out;
}

export function deriveModelId(file: string): string {
  let name = basename(file).replace(/\.gguf$/i, "");
  const sm = name.match(/^(.*)-\d{5}-of-\d{5}$/);
  if (sm) name = sm[1];
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** List the `.gguf` filenames in a HuggingFace repo (a given revision). */
export async function hfListGguf(repo: string, rev: string, token?: string): Promise<string[]> {
  const url =
    rev && rev !== "main"
      ? `https://huggingface.co/api/models/${repo}/revision/${encodeURIComponent(rev)}`
      : `https://huggingface.co/api/models/${repo}`;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    throw new Error(
      `HuggingFace API returned ${resp.status} for ${repo}` +
        (resp.status === 401 || resp.status === 403
          ? " (private/gated — set localModels.hfToken or the HF_TOKEN env var)"
          : ""),
    );
  }
  const data = (await resp.json()) as { siblings?: Array<{ rfilename: string }> };
  return (data.siblings ?? []).map((s) => s.rfilename).filter((f) => /\.gguf$/i.test(f));
}

// ── Model-browser helpers (HF search + per-repo quant listing) ──────────

export interface HfSearchResult {
  id: string;
  author: string;
  downloads: number;
  likes: number;
  lastModified?: string;
  pipelineTag?: string;
  tags: string[];
}

export interface HfSearchOpts {
  query?: string;
  author?: string;
  sort?: "downloads" | "likes" | "lastModified" | "trendingScore";
  limit?: number;
  /** Optional HF task filter, e.g. "image-text-to-text" for vision models. */
  pipelineTag?: string;
  /** Opaque cursor from a previous page's `nextCursor` (load-more). */
  cursor?: string;
}

export interface HfSearchPage {
  results: HfSearchResult[];
  /** Cursor for the next page (from the HF `Link: rel="next"` header), or null
   *  when there are no more results. */
  nextCursor: string | null;
}

/** Pull the `cursor=` value out of HF's `Link: <url>; rel="next"` header. */
function parseNextCursor(link: string | null): string | null {
  if (!link) return null;
  const m = link.match(/<([^>]+)>;\s*rel="next"/);
  if (!m) return null;
  try {
    return new URL(m[1]).searchParams.get("cursor");
  } catch {
    return null;
  }
}

/**
 * Search/browse HuggingFace GGUF models. With no query AND no author it browses
 * (e.g. sort=trendingScore for the landing feed). Supports a pipeline_tag
 * facet and cursor pagination (the returned nextCursor feeds load-more). Sort
 * is always descending — HF's /api/models rejects ascending ("only descending
 * sort is supported"). expand[] pulls badges/dates in one request.
 */
export async function hfSearch(opts: HfSearchOpts, token?: string): Promise<HfSearchPage> {
  const params = new URLSearchParams();
  if (opts.query) params.set("search", opts.query);
  if (opts.author) params.set("author", opts.author);
  if (opts.pipelineTag) params.set("pipeline_tag", opts.pipelineTag);
  params.set("filter", "gguf");
  params.set("sort", opts.sort || "downloads");
  params.set("direction", "-1");
  params.set("limit", String(Math.min(60, Math.max(1, opts.limit || 30))));
  if (opts.cursor) params.set("cursor", opts.cursor);
  // expand[] (appended raw — URLSearchParams would escape the brackets) gets
  // the extra fields the browser cards need without a per-model round-trip.
  const url =
    `https://huggingface.co/api/models?${params.toString()}` +
    `&expand[]=downloads&expand[]=likes&expand[]=lastModified&expand[]=pipeline_tag&expand[]=tags`;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`HuggingFace search returned ${resp.status}`);
  const data = (await resp.json()) as Array<{
    id: string;
    author?: string;
    downloads?: number;
    likes?: number;
    lastModified?: string;
    pipeline_tag?: string;
    tags?: string[];
  }>;
  return {
    results: data.map((m) => ({
      id: m.id,
      author: m.author || (m.id.includes("/") ? m.id.split("/")[0] : ""),
      downloads: m.downloads ?? 0,
      likes: m.likes ?? 0,
      lastModified: m.lastModified,
      pipelineTag: m.pipeline_tag,
      tags: Array.isArray(m.tags) ? m.tags : [],
    })),
    nextCursor: parseNextCursor(resp.headers.get("link")),
  };
}

export interface HfAuthor {
  name: string;
  fullname?: string;
  avatarUrl?: string;
  numModels?: number;
  type: "user" | "org";
}

/** Look up an author's profile (avatar, full name, model count). Tries the
 *  user endpoint then the org endpoint — HF splits the two. null if neither. */
export async function hfAuthor(name: string, token?: string): Promise<HfAuthor | null> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  for (const [type, seg] of [["user", "users"], ["org", "organizations"]] as const) {
    try {
      const r = await fetch(`https://huggingface.co/api/${seg}/${encodeURIComponent(name)}/overview`, { headers });
      if (!r.ok) continue;
      const d = (await r.json()) as { fullname?: string; avatarUrl?: string; numModels?: number };
      return { name, fullname: d.fullname, avatarUrl: d.avatarUrl, numModels: d.numModels, type };
    } catch {
      /* try next */
    }
  }
  return null;
}

export interface HfQuantFile {
  /** Quant label, e.g. "Q4_K_M". */
  quant: string;
  /** Representative filename (first part for split sets) — use as the pull spec tail. */
  filename: string;
  /** Total bytes (summed across split parts). */
  sizeBytes: number;
  /** Number of GGUF parts (1 unless a split model). */
  parts: number;
}

/**
 * List a repo's GGUF files as pullable quants, with sizes, smallest first.
 * Split sets (`*-00001-of-0000N.gguf`) collapse to one entry (summed size,
 * represented by the first part). Uses the tree API for LFS file sizes.
 */
export async function hfRepoQuants(repo: string, token?: string): Promise<HfQuantFile[]> {
  const url = `https://huggingface.co/api/models/${repo}/tree/main?recursive=true`;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`HuggingFace returned ${resp.status} for ${repo}`);
  const tree = (await resp.json()) as Array<{ type: string; path: string; size?: number }>;
  // Exclude mmproj projector files — multimodal repos ship these tiny aux
  // GGUFs alongside the real weights, and they'd otherwise show as bogus
  // "F16 1.1 GB"-style quant rows.
  const ggufs = tree.filter(
    (t) => t.type === "file" && /\.gguf$/i.test(t.path) && !/mmproj/i.test(t.path),
  );

  const groups = new Map<string, HfQuantFile>();
  for (const f of ggufs) {
    const name = basename(f.path);
    const sm = splitMatch(name);
    const key = sm ? sm.base : name;
    const existing = groups.get(key);
    if (existing) {
      existing.sizeBytes += f.size ?? 0;
      existing.parts += 1;
      if (sm && sm.idx === 1) existing.filename = name; // first part is the pull target
    } else {
      groups.set(key, { quant: extractQuant(name) ?? name.replace(/\.gguf$/i, ""), filename: name, sizeBytes: f.size ?? 0, parts: 1 });
    }
  }
  // Collapse to one entry per quant label — some repos ship both a
  // single-file and a split version of the same quant; prefer the
  // single-file packaging (cleaner to pull), keep the split only if that's
  // all there is.
  const byQuant = new Map<string, HfQuantFile>();
  for (const g of groups.values()) {
    const cur = byQuant.get(g.quant);
    if (!cur || (cur.parts > 1 && g.parts === 1)) byQuant.set(g.quant, g);
  }
  return [...byQuant.values()].sort((a, b) => a.sizeBytes - b.sizeBytes);
}

// ── Model detail (README + parsed GGUF metadata + capabilities) ─────────
//
// Powers the browser's master-detail pane so picking a model never means
// opening huggingface.co. One /api/models call with expand[] gives the
// GGUF-parsed facts (exact param count, trained context, architecture, chat
// template) plus cardData (license/languages/base model); a second cheap
// GET pulls the raw README which we render client-side. Capability flags are
// derived from the chat template — the same template llama.cpp runs under
// --jinja, so "has tool-call grammar" / "emits <think>" are honest signals.

export interface HfQuantDetail extends HfQuantFile {
  /** GPU-fit verdict for the detected VRAM at the estimate context. Absent
   *  when VRAM is unknown. */
  fit?: HfFit;
  /** True for the single quant recommend()-ed as the best size↔quality pick
   *  that comfortably fits the detected VRAM. */
  recommended?: boolean;
}

export interface HfModelDetail {
  id: string;
  author: string;
  /** SPDX-ish license string from cardData, e.g. "apache-2.0". */
  license?: string;
  /** ISO language codes declared on the card. */
  languages: string[];
  /** Upstream model this was quantized from (provenance). */
  baseModel?: string;
  /** Who produced the quant (cardData.quantized_by), e.g. "bartowski". */
  quantizedBy?: string;
  pipelineTag?: string;
  tags: string[];
  downloads: number;
  likes: number;
  lastModified?: string;
  /** Parsed straight out of the GGUF header by HF (quant-independent). */
  gguf: {
    architecture?: string;
    /** Trained context window in tokens. */
    contextLength?: number;
    /** Exact parameter COUNT (not bytes), e.g. 7_615_616_512. */
    paramCount?: number;
  };
  /** Chat template advertises the tool-call format llama.cpp needs (--jinja). */
  supportsTools: boolean;
  /** Chat template / id indicates chain-of-thought (<think>, R1/QwQ). */
  reasoning: boolean;
  /** Rendered client-side; YAML frontmatter already stripped. Empty if the
   *  repo has no README or it couldn't be fetched. */
  readmeMarkdown: string;
  /** The repo's pullable quants, smallest first (from hfRepoQuants). */
  quants: HfQuantDetail[];
  /** Filename of the recommended quant, mirrored onto the quant's
   *  `recommended` flag. null when VRAM is unknown or nothing fits. */
  recommendedQuant: string | null;
  /** The context (tokens) the fit verdicts were estimated at, so the UI can
   *  say "fits at 32K ctx". */
  fitContext?: number;
}

function hfHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Strip a leading YAML frontmatter block (`---\n…\n---`). cardData already
 *  carries those fields, so it's redundant noise in the rendered card. */
function stripFrontmatter(md: string): string {
  return md.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trimStart();
}

/**
 * Fetch everything the detail pane needs for one repo: parsed GGUF metadata +
 * card fields (one /api/models call), the raw README, and the quant list.
 * README + quants are best-effort (a missing README or tree hiccup degrades
 * gracefully); only the metadata call is load-bearing.
 */
export async function hfModel(repo: string, token?: string): Promise<HfModelDetail> {
  const headers = hfHeaders(token);
  const metaUrl =
    `https://huggingface.co/api/models/${repo}` +
    `?expand[]=gguf&expand[]=cardData&expand[]=tags&expand[]=downloads&expand[]=likes&expand[]=lastModified&expand[]=pipeline_tag`;

  const [metaResp, readmeResult, quantsResult] = await Promise.all([
    fetch(metaUrl, { headers }),
    fetch(`https://huggingface.co/${repo}/raw/main/README.md`, { headers })
      .then((r) => (r.ok ? r.text() : ""))
      .catch(() => ""),
    hfRepoQuants(repo, token).catch(() => [] as HfQuantFile[]),
  ]);

  if (!metaResp.ok) {
    throw new Error(
      `HuggingFace returned ${metaResp.status} for ${repo}` +
        (metaResp.status === 401 || metaResp.status === 403
          ? " (private/gated — set localModels.hfToken or the HF_TOKEN env var)"
          : ""),
    );
  }
  const m = (await metaResp.json()) as {
    id: string;
    author?: string;
    downloads?: number;
    likes?: number;
    lastModified?: string;
    pipeline_tag?: string;
    tags?: string[];
    gguf?: { total?: number; architecture?: string; context_length?: number; chat_template?: string };
    cardData?: {
      license?: string;
      language?: string | string[];
      base_model?: string | string[];
      pipeline_tag?: string;
      quantized_by?: string;
    };
  };

  const card = m.cardData ?? {};
  const template = m.gguf?.chat_template ?? "";
  const idLower = m.id.toLowerCase();
  const supportsTools = /tool_call|<tools>|"tools"/i.test(template);
  const reasoning =
    /<think>|reasoning_content/i.test(template) ||
    /(?:^|[-_/ ])(r1|qwq|reason|think)/.test(idLower) ||
    /deepseek-r1/.test(idLower);

  const langs = Array.isArray(card.language)
    ? card.language
    : card.language
      ? [card.language]
      : [];
  const baseModel = Array.isArray(card.base_model) ? card.base_model[0] : card.base_model;

  const readme = stripFrontmatter((readmeResult || "").slice(0, 80_000));

  return {
    id: m.id,
    author: m.author || (m.id.includes("/") ? m.id.split("/")[0] : ""),
    license: card.license,
    languages: langs,
    baseModel,
    quantizedBy: card.quantized_by,
    pipelineTag: m.pipeline_tag || card.pipeline_tag,
    tags: Array.isArray(m.tags) ? m.tags : [],
    downloads: m.downloads ?? 0,
    likes: m.likes ?? 0,
    lastModified: m.lastModified,
    gguf: {
      architecture: m.gguf?.architecture,
      contextLength: m.gguf?.context_length,
      paramCount: m.gguf?.total,
    },
    supportsTools,
    reasoning,
    readmeMarkdown: readme,
    quants: quantsResult as HfQuantDetail[],
    recommendedQuant: null,
    fitContext: undefined,
  };
}

// ── GPU-fit estimation ──────────────────────────────────────────────────
//
// Honest about its limits: the HF API gives us a quant's on-disk size
// (exact), the model's param count and trained context — but NOT the layer /
// head-dim shapes that set the true KV-cache footprint. So weights are exact
// and the KV term is a GQA-calibrated heuristic (power-law fit to Qwen2.5-7B
// ≈56 KB/token and Llama-3-70B ≈320 KB/token at f16). Good enough to call
// fits / tight / partial at a given context; not a VRAM profiler. MoE models
// over-estimate KV (it scales attention dims, not expert count) — i.e. the
// estimate errs conservative, which is the safe direction.

export type HfFitClass = "fits" | "tight" | "toobig";

export interface HfFit {
  cls: HfFitClass;
  label: string;
  /** weights + KV + runtime overhead, bytes. */
  totalBytes: number;
  kvBytes: number;
  /** Context (tokens) this verdict assumes. */
  atContext: number;
}

const KV_TYPE_FACTOR: Record<string, number> = { f16: 1, q8_0: 0.5, q4_0: 0.25 };

/** Estimated KV-cache bytes for `contextTokens` at the given param count. */
function estimateKvBytes(paramCount: number, contextTokens: number, kvType = "f16"): number {
  const paramsB = Math.max(0.1, paramCount / 1e9);
  const kbPerTokF16 = 11.36 * Math.pow(paramsB, 0.785); // GQA-calibrated
  const factor = KV_TYPE_FACTOR[kvType] ?? 1;
  return kbPerTokF16 * 1024 * contextTokens * factor;
}

export interface FitParams {
  weightsBytes: number;
  paramCount?: number;
  contextTokens: number;
  kvType?: string;
  vramBytes: number;
}

/**
 * Estimate whether a quant fits the detected VRAM at a working context:
 * exact weights + heuristic KV + fixed runtime overhead (CUDA context +
 * compute buffers, ~0.7 GB + 5% of weights). Thresholds keep a safety margin
 * for the estimate error and other VRAM consumers (desktop, browser).
 */
export function estimateFit(p: FitParams): HfFit {
  const kvBytes = p.paramCount
    ? estimateKvBytes(p.paramCount, p.contextTokens, p.kvType)
    : p.weightsBytes * 0.2; // no param count → crude proxy off weights
  const overhead = 0.7e9 + p.weightsBytes * 0.05;
  const totalBytes = p.weightsBytes + kvBytes + overhead;
  const ratio = p.vramBytes > 0 ? totalBytes / p.vramBytes : Infinity;
  const cls: HfFitClass = ratio <= 0.85 ? "fits" : ratio <= 1.0 ? "tight" : "toobig";
  const label = cls === "fits" ? "fits" : cls === "tight" ? "tight" : "partial offload";
  return { cls, label, totalBytes, kvBytes, atContext: p.contextTokens };
}

/** F16/BF16/F32 are unquantized — wasteful for inference (Q8_0 is already
 *  near-lossless at half the size), so they're never the recommended pick
 *  unless a repo ships nothing else. */
const FULL_PRECISION_QUANT = /^(B?F16|FP16|F32|FP32)$/i;

/**
 * Pick the best quant for the detected VRAM: the largest (highest-quality)
 * quant that *comfortably* fits, excluding wasteful full-precision formats.
 * Falls back to the largest merely-"tight" quant if nothing fits comfortably,
 * and returns null when the model is genuinely too big for this GPU (so the
 * UI honestly shows no recommendation rather than crowning a 1-bit quant).
 * Also null when VRAM is unknown / there are no quants. Quants arrive sorted
 * small→large.
 */
export function recommendQuant(
  quants: HfQuantFile[],
  opts: { paramCount?: number; contextTokens: number; vramBytes: number },
): string | null {
  if (!quants.length || opts.vramBytes <= 0) return null;
  const inferenceQuants = quants.filter((q) => !FULL_PRECISION_QUANT.test(q.quant));
  // If a repo is ONLY full-precision (rare), let those back in.
  const pool = inferenceQuants.length ? inferenceQuants : quants;
  const fitClass = (q: HfQuantFile) =>
    estimateFit({
      weightsBytes: q.sizeBytes,
      paramCount: opts.paramCount,
      contextTokens: opts.contextTokens,
      vramBytes: opts.vramBytes,
    }).cls;
  const fits = pool.filter((q) => fitClass(q) === "fits");
  if (fits.length) return fits[fits.length - 1].filename;
  const tight = pool.filter((q) => fitClass(q) === "tight");
  if (tight.length) return tight[tight.length - 1].filename;
  return null; // nothing fits — too big for this GPU
}

/**
 * Annotate a model detail's quants with per-quant fit verdicts + the
 * recommended pick, estimated at a sensible working context (trained context
 * capped at 32K so a 1M-context model doesn't blow the estimate). Mutates +
 * returns the detail. No-op when VRAM is unknown.
 */
export function annotateFit(detail: HfModelDetail, vramBytes: number): HfModelDetail {
  if (vramBytes <= 0 || !detail.quants.length) return detail;
  const ctx = Math.min(detail.gguf.contextLength || 8192, 32768);
  detail.fitContext = ctx;
  for (const q of detail.quants) {
    q.fit = estimateFit({
      weightsBytes: q.sizeBytes,
      paramCount: detail.gguf.paramCount,
      contextTokens: ctx,
      vramBytes,
    });
  }
  detail.recommendedQuant = recommendQuant(detail.quants, {
    paramCount: detail.gguf.paramCount,
    contextTokens: ctx,
    vramBytes,
  });
  for (const q of detail.quants) q.recommended = q.filename === detail.recommendedQuant;
  return detail;
}

// ── Recommended runtime settings for an INSTALLED model ─────────────────────
// The browser's recommendQuant() picks a quant before download; this picks the
// best spawn settings (mainly context size) for a model already on disk, sized
// to the GPU. It inverts estimateFit's KV term — which is linear in context —
// to solve for the largest context that fits the VRAM budget, then caps at the
// model's trained length. f16 KV is preferred; q8_0 (near-lossless, half the
// KV) is chosen only when f16 can't reach the cap, to buy more context.

const CTX_PRESETS = [2048, 4096, 8192, 16384, 32768, 65536, 131072];
const DEFAULT_TRAINED_CAP = 8192; // when the trained context is unknown
const MIN_USABLE_CONTEXT = 2048;

/** Largest context preset ≤ n (rounding down is conservative — it keeps the
 *  fit estimate honest and lands on the settings UI's dropdown options). */
function snapCtxDown(n: number): number {
  let best = CTX_PRESETS[0];
  for (const p of CTX_PRESETS) {
    if (p <= n) best = p;
    else break;
  }
  return best;
}

function ctxLabel(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)}K` : String(n);
}

export interface RecommendInput {
  /** On-disk weights size (sum of all GGUF parts), bytes. */
  weightsBytes: number;
  /** Param count for the KV heuristic. Undefined → KV can't be sized; falls
   *  back to a capped context with no GPU math. */
  paramCount?: number;
  /** Model's trained context length (tokens) — the hard ceiling. Undefined →
   *  a conservative default cap is used instead. */
  trainedContext?: number;
  /** Live free VRAM right now, bytes (nvidia-smi memory.free). 0/undefined →
   *  GPU unknown; degrades to a capped context with no fit math. */
  freeBytes?: number;
  /** Total VRAM, bytes — only for the "on a free GPU you could do X" hint. */
  totalBytes?: number;
  /** Headroom to leave free, bytes (config.localModels.reservedVramBytes). */
  cushionBytes: number;
  /** Optional context cap (tokens). The download default passes ~32K for a
   *  balanced baseline; the live button passes none (push to trained max). */
  ceilingTokens?: number;
  /** Quant tag (e.g. "Q4_K_M", "IQ3_XS") — drives the low-bit sampling nudge. */
  quant?: string;
  /** Model id or source repo — drives family-aware sampling defaults. */
  idOrSource?: string;
}

export interface Recommendation {
  /** Recommended -c / --ctx-size (tokens). null when it can't be sized
   *  (weights exceed the budget). */
  ctxSize: number | null;
  kvCacheType: "f16" | "q8_0" | "q4_0";
  flashAttn: "auto" | "on" | "off";
  gpuLayers: number;
  /** Do the weights alone fit the budget? false ⇒ partial CPU offload. */
  weightsFit: boolean;
  /** Bytes available to the model (freeBytes − cushion). */
  budgetBytes: number;
  /** Estimated KV bytes at the recommended context. */
  kvBytes: number;
  /** "On a free GPU you could do X tokens" hint — when totalBytes is given. */
  freeGpuContext?: number;
  /** Recommended sampling — family defaults, tightened for low-bit quants. */
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  /** Detected model family the sampling came from ("gemma" / "default" / …). */
  samplingFamily?: string;
  /** Human-readable one-liner for the settings modal. */
  rationale: string;
}

/** Per-token KV cost (bytes) at the given KV type, from the GQA heuristic. */
function kvBytesPerToken(paramCount: number, kvType: string): number {
  return estimateKvBytes(paramCount, 1, kvType);
}

/** Steadier sampling for low-bit quants (Q3/IQ3 and below) — the ones prone to
 *  stray "glitch" tokens. Q4+ get no override (left at the user's / config
 *  default). Surfaced by recommendSettings so the button previews it too. */
function lowQuantSampling(quant?: string): { temperature?: number; minP?: number } {
  if (!quant) return {};
  const m = /^I?Q(\d)/i.exec(quant);
  if (!m) return {}; // F16/BF16/unknown → no nudge
  const bits = parseInt(m[1], 10);
  if (bits <= 2) return { temperature: 0.4, minP: 0.1 }; // Q2/IQ2 — aggressive
  if (bits <= 3) return { temperature: 0.5, minP: 0.08 }; // Q3/IQ3 — steadier
  return {};
}

interface FamilySampling {
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  repeatPenalty: number;
}

// Per-family recommended sampling, approximating each family's published
// generation config. Families not listed fall back to DEFAULT_SAMPLING — a
// solid, generally-accepted baseline.
const FAMILY_SAMPLING: Record<string, FamilySampling> = {
  gemma:    { temperature: 1.0, topP: 0.95, topK: 64, minP: 0.0, repeatPenalty: 1.0 },
  qwen3:    { temperature: 0.7, topP: 0.8, topK: 20, minP: 0.0, repeatPenalty: 1.05 },
  qwen:     { temperature: 0.7, topP: 0.8, topK: 20, minP: 0.0, repeatPenalty: 1.05 },
  llama:    { temperature: 0.6, topP: 0.9, topK: 0, minP: 0.0, repeatPenalty: 1.1 },
  deepseek: { temperature: 0.6, topP: 0.95, topK: 0, minP: 0.0, repeatPenalty: 1.0 },
  mistral:  { temperature: 0.7, topP: 0.95, topK: 0, minP: 0.0, repeatPenalty: 1.1 },
  phi:      { temperature: 0.7, topP: 0.9, topK: 0, minP: 0.0, repeatPenalty: 1.1 },
};
const DEFAULT_SAMPLING: FamilySampling = { temperature: 0.7, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1.1 };

/** Detect model family from its id or source repo (best-effort substring match). */
function detectFamily(idOrSource: string): string {
  const s = idOrSource.toLowerCase();
  if (/gemma/.test(s)) return "gemma";
  if (/qwen-?3|qwq/.test(s)) return "qwen3";
  if (/qwen/.test(s)) return "qwen";
  if (/llama|nemotron/.test(s)) return "llama";
  if (/deepseek/.test(s)) return "deepseek";
  if (/mi[sx]tral/.test(s)) return "mistral";
  if (/phi-?\d/.test(s)) return "phi";
  return "";
}

/** Recommended sampling for a model: its family's published config (or a solid
 *  default), with the low-bit-quant nudge layered on top (lower temp / floor
 *  min_p) for Q3-and-below. Returns the resolved family for the rationale. */
function recommendedSampling(
  idOrSource: string | undefined,
  quant: string | undefined,
): FamilySampling & { family: string } {
  const fam = idOrSource ? detectFamily(idOrSource) : "";
  const base: FamilySampling = { ...(FAMILY_SAMPLING[fam] ?? DEFAULT_SAMPLING) };
  const lq = lowQuantSampling(quant);
  if (lq.temperature != null) base.temperature = Math.min(base.temperature, lq.temperature);
  if (lq.minP != null) base.minP = Math.max(base.minP, lq.minP);
  return { ...base, family: fam || "default" };
}

/**
 * Recommend spawn settings (context + KV type + flash-attn + GPU layers) for
 * an installed model against a live VRAM budget. Honest when the weights don't
 * fit the budget (partial offload — a smaller quant is the real fix) or when
 * VRAM / param count is unknown.
 */
export function recommendSettings(p: RecommendInput): Recommendation {
  const trainedCap = p.trainedContext && p.trainedContext > 0 ? p.trainedContext : DEFAULT_TRAINED_CAP;
  const hardCap =
    p.ceilingTokens && p.ceilingTokens > 0 ? Math.min(trainedCap, p.ceilingTokens) : trainedCap;
  const free = p.freeBytes ?? 0;
  const budget = Math.max(0, free - p.cushionBytes);
  const overhead = 0.7e9 + p.weightsBytes * 0.05; // CUDA context + compute buffers

  const sr = recommendedSampling(p.idOrSource, p.quant); // family defaults + low-quant nudge
  const sampling = { temperature: sr.temperature, topP: sr.topP, topK: sr.topK, minP: sr.minP, repeatPenalty: sr.repeatPenalty };
  const base = { kvCacheType: "f16" as const, flashAttn: "auto" as const, gpuLayers: -1, ...sampling, samplingFamily: sr.family };

  // GPU reading unavailable → can't size against VRAM.
  if (free <= 0) {
    return {
      ...base, ctxSize: snapCtxDown(hardCap), weightsFit: true, budgetBytes: 0, kvBytes: 0,
      rationale: `GPU VRAM unknown (no NVIDIA reading) — recommending ${ctxLabel(snapCtxDown(hardCap))} context. Load it and watch for an out-of-memory error.`,
    };
  }

  const kvRoom = budget - p.weightsBytes - overhead;
  if (kvRoom <= 0) {
    return {
      ...base, ctxSize: null, weightsFit: false, budgetBytes: budget, kvBytes: 0,
      rationale: `Weights (~${fmtBytes(p.weightsBytes)}) exceed usable VRAM (~${fmtBytes(budget)} = ${fmtBytes(free)} free − ${fmtBytes(p.cushionBytes)} reserved) — it'll partly offload to CPU and run slow. A smaller quant would fit.`,
    };
  }

  // Without a param count the KV heuristic can't run; recommend a capped ctx.
  if (!p.paramCount || p.paramCount <= 0) {
    return {
      ...base, ctxSize: snapCtxDown(hardCap), weightsFit: true, budgetBytes: budget, kvBytes: 0,
      rationale: `Recommending ${ctxLabel(snapCtxDown(hardCap))} context (couldn't read the parameter count to size the KV cache precisely).`,
    };
  }

  const maxCtxF16 = Math.floor(kvRoom / kvBytesPerToken(p.paramCount, "f16"));
  let kvCacheType: "f16" | "q8_0" = "f16";
  let rawCtx = Math.min(maxCtxF16, hardCap);
  // f16 can't reach the cap → q8_0 (≈half the KV, near-lossless) buys ~2× ctx.
  if (maxCtxF16 < hardCap) {
    const maxCtxQ8 = Math.floor(kvRoom / kvBytesPerToken(p.paramCount, "q8_0"));
    if (maxCtxQ8 > maxCtxF16) {
      kvCacheType = "q8_0";
      rawCtx = Math.min(maxCtxQ8, hardCap);
    }
  }
  const ctx = Math.max(MIN_USABLE_CONTEXT, snapCtxDown(rawCtx));
  const flashAttn: "auto" | "on" | "off" = kvCacheType === "f16" ? "auto" : "on";
  const kvBytes = estimateKvBytes(p.paramCount, ctx, kvCacheType);

  // "On a free GPU" ceiling hint (f16, against total − cushion).
  let freeGpuContext: number | undefined;
  if (p.totalBytes && p.totalBytes > 0) {
    const freeRoom = Math.max(0, p.totalBytes - p.cushionBytes) - p.weightsBytes - overhead;
    if (freeRoom > 0) {
      freeGpuContext = Math.min(hardCap, snapCtxDown(Math.floor(freeRoom / kvBytesPerToken(p.paramCount, "f16"))));
    }
  }

  const kvNote = kvCacheType === "f16" ? "f16 KV" : `${kvCacheType} KV (near-lossless, frees room)`;
  const total = p.weightsBytes + kvBytes + overhead;
  let rationale =
    `${ctxLabel(ctx)} context · ${kvNote} · full GPU offload — fits ~${fmtBytes(total)} of ` +
    `${fmtBytes(budget)} usable (${fmtBytes(free)} free − ${fmtBytes(p.cushionBytes)} reserved).`;
  if (ctx >= hardCap) {
    rationale += ` Capped at the model's ${hardCap < trainedCap ? "balanced ceiling" : "trained limit"} (${ctxLabel(hardCap)}).`;
  }
  if (freeGpuContext && freeGpuContext > ctx) {
    rationale += ` On a free GPU (~${fmtBytes(p.totalBytes!)}): up to ${ctxLabel(freeGpuContext)}.`;
  }
  rationale += ` Sampling: ${sr.family} (temp ${sampling.temperature}, top_p ${sampling.topP}, top_k ${sampling.topK}, min_p ${sampling.minP}).`;

  return { ctxSize: ctx, kvCacheType, flashAttn, gpuLayers: -1, weightsFit: true, budgetBytes: budget, kvBytes, freeGpuContext, ...sampling, samplingFamily: sr.family, rationale };
}

export interface ResolvedSpec {
  repo: string;
  revision: string;
  files: string[];
  quant?: string;
}

export async function resolveSpec(spec: string, defaultRev: string, token?: string): Promise<ResolvedSpec> {
  let repo = "";
  let revision = defaultRev;
  let explicitFile: string | undefined;
  let quant: string | undefined;

  if (/^https?:\/\//i.test(spec)) {
    const u = new URL(spec);
    const parts = u.pathname.replace(/^\/+/, "").split("/");
    if (parts.length >= 2) repo = `${parts[0]}/${parts[1]}`;
    const marker = parts[2];
    if ((marker === "resolve" || marker === "blob") && parts.length >= 5) {
      revision = parts[3];
      explicitFile = decodeURIComponent(parts.slice(4).join("/"));
    }
  } else {
    let s = spec.replace(/^hf\.co\//i, "").replace(/^huggingface\.co\//i, "");
    const colonIdx = s.lastIndexOf(":");
    if (colonIdx > 0 && !s.slice(colonIdx + 1).includes("/")) {
      const tag = s.slice(colonIdx + 1);
      s = s.slice(0, colonIdx);
      if (/\.gguf$/i.test(tag)) explicitFile = tag;
      else quant = tag;
    }
    repo = s;
  }

  if (!repo || repo.split("/").length < 2) {
    throw new Error(
      `Could not parse a HuggingFace repo from "${spec}". Use org/repo[:quant], org/repo:file.gguf, or a full huggingface.co URL.`,
    );
  }

  if (explicitFile) {
    const listing = await hfListGguf(repo, revision, token).catch(() => [] as string[]);
    return { repo, revision, files: expandSplit(explicitFile, listing), quant: quant ?? extractQuant(explicitFile) };
  }

  const ggufs = await hfListGguf(repo, revision, token);
  if (ggufs.length === 0) throw new Error(`No .gguf files found in ${repo}.`);

  let candidates = ggufs;
  if (quant) {
    const q = quant.toLowerCase();
    candidates = ggufs.filter((f) => basename(f).toLowerCase().includes(q));
    if (candidates.length === 0) {
      throw new Error(`No GGUF matching quant "${quant}" in ${repo}. Available: ${uniqueQuants(ggufs).join(", ")}`);
    }
  }

  const reps = pickRepresentatives(candidates);
  if (reps.length > 1) {
    const example = uniqueQuants(reps)[0] ?? "Q4_K_M";
    throw new Error(
      `Multiple GGUF files in ${repo} — specify a quant, e.g. ${repo}:${example}. Options: ${reps.map((f) => basename(f)).join(", ")}`,
    );
  }

  const chosen = reps[0];
  return { repo, revision, files: expandSplit(chosen, ggufs), quant: quant ?? extractQuant(chosen) };
}

export interface PullProgress {
  phase: "resolving" | "downloading" | "registering" | "done" | "error";
  spec?: string;
  file?: string;
  fileIndex?: number;
  fileCount?: number;
  receivedBytes?: number;
  totalBytes?: number;
  speedBytesPerSec?: number;
  modelId?: string;
  error?: string;
  message?: string;
}

async function downloadFile(
  url: string,
  dest: string,
  token: string | undefined,
  onChunk?: (received: number, total: number, speed: number) => void,
): Promise<number> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(url, { headers, redirect: "follow" });
  if (!resp.ok || !resp.body) {
    throw new Error(`Download failed (${resp.status} ${resp.statusText}) for ${url}`);
  }
  const total = Number(resp.headers.get("content-length") || 0);
  // Stream into a .part sibling and rename on success — a dropped
  // connection used to leave a truncated GGUF at the FINAL path, which
  // the registry then treated as a valid model (llama-server failed
  // confusingly at load time).
  const partPath = `${dest}.part`;
  const sink = Bun.file(partPath).writer();
  const reader = resp.body.getReader();
  let received = 0;
  let sinceFlush = 0;
  const FLUSH_EVERY = 32 * 1024 * 1024;
  const start = Date.now();
  let lastCb = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sink.write(value);
      received += value.length;
      sinceFlush += value.length;
      if (sinceFlush >= FLUSH_EVERY) {
        await sink.flush();
        sinceFlush = 0;
      }
      const now = Date.now();
      if (now - lastCb > 200) {
        lastCb = now;
        onChunk?.(received, total, received / ((now - start) / 1000));
      }
    }
    await sink.end();
    // Server declared a length and we got less — torn transfer, not done.
    if (total > 0 && received < total) {
      throw new Error(`Download incomplete (${received}/${total} bytes) for ${url}`);
    }
    renameSync(partPath, dest);
  } catch (err) {
    await Promise.resolve(sink.end()).catch(() => {});
    try {
      if (existsSync(partPath)) unlinkSync(partPath);
    } catch {
      /* best effort */
    }
    throw err;
  }
  return received;
}

export interface PullParams {
  modelsDirAbs: string;
  hfToken?: string;
  spec: string;
  idOverride?: string;
  revision?: string;
  noTools?: boolean;
  // Capability hints from the model browser (derived from the GGUF chat
  // template). When present they win over the id-regex guess, so a model
  // arrives correctly configured: reasoning models get reasoning:true, and a
  // model with no tool-call template gets toolMode "off" instead of the
  // "core" default it can't honor. Absent for the paste-a-link path.
  reasoning?: boolean;
  supportsTools?: boolean;
}

/**
 * Resolve + download + register a model. Streams progress through
 * `onProgress`. Returns the registered model id + total bytes. Throws (with a
 * descriptive message) on resolution / download failure.
 */
export async function pullModel(
  params: PullParams,
  onProgress?: (p: PullProgress) => void,
): Promise<{ modelId: string; bytes: number; file: string }> {
  const { modelsDirAbs, hfToken, spec } = params;
  const revision = params.revision || "main";
  const weightsDir = modelsWeightsDir(modelsDirAbs);
  if (!existsSync(weightsDir)) mkdirSync(weightsDir, { recursive: true });

  onProgress?.({ phase: "resolving", spec, message: `resolving ${spec}` });
  const resolved = await resolveSpec(spec, revision, hfToken);

  let totalBytes = 0;
  const fileCount = resolved.files.length;
  for (let i = 0; i < resolved.files.length; i++) {
    const fname = resolved.files[i];
    const dest = resolve(weightsDir, basename(fname));
    const url = `https://huggingface.co/${resolved.repo}/resolve/${resolved.revision}/${encodeURI(fname)}?download=true`;
    totalBytes += await downloadFile(url, dest, hfToken, (received, total, speed) => {
      onProgress?.({
        phase: "downloading",
        spec,
        file: basename(fname),
        fileIndex: i + 1,
        fileCount,
        receivedBytes: received,
        totalBytes: total,
        speedBytesPerSec: speed,
      });
    });
  }

  onProgress?.({ phase: "registering", spec });
  const primary = resolved.files[0];
  const id = params.idOverride || deriveModelId(primary);
  const haystack = `${resolved.repo} ${primary}`.toLowerCase();
  const reasoningDerived =
    /(?:^|[-_/ ])(r1|qwq|reason|think)/.test(haystack) || /deepseek-r1/.test(haystack);
  const reasoning = params.reasoning ?? reasoningDerived;
  // Browser-known no-tool models get "off"; the explicit noTools flag still
  // forces off; otherwise leave undefined so the config default ("core") applies.
  const toolMode = params.noTools || params.supportsTools === false ? "off" : undefined;
  upsertModel(modelsDirAbs, {
    id,
    file: basename(primary),
    name: id,
    source: resolved.repo,
    quant: resolved.quant,
    sizeBytes: totalBytes,
    reasoning: reasoning || undefined,
    toolMode,
    pulledAt: new Date().toISOString(),
  });

  onProgress?.({ phase: "done", spec, modelId: id, totalBytes, receivedBytes: totalBytes });
  return { modelId: id, bytes: totalBytes, file: basename(primary) };
}
