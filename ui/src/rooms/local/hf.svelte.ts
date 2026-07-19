// HuggingFace model-browser state + actions (the browse half of ui/local.js).
// Search / trending browse / author scope / detail (specs + quants + README)
// against /api/local/hf/*, plus the sequential download queue (/api/local/
// pull) with its polled tray.
import { local, fetchLocalStatus } from './local.svelte';

export interface HfResult {
  id: string; // org/repo
  downloads?: number;
  likes?: number;
  tags?: string[];
  pipelineTag?: string;
  lastModified?: string;
}

export interface HfAuthor {
  name: string;
  fullname?: string;
  avatarUrl?: string;
  numModels?: number;
  type?: string;
}

export interface HfQuant {
  quant: string;
  filename: string;
  sizeBytes: number;
  parts?: number;
  recommended?: boolean;
  fit?: { cls: string; label: string };
}

export interface HfDetail extends HfResult {
  license?: string;
  languages?: string[];
  baseModel?: string;
  quantizedBy?: string;
  readmeMarkdown?: string;
  supportsTools?: boolean;
  reasoning?: boolean;
  fitContext?: number;
  gguf?: { paramCount?: number; contextLength?: number; architecture?: string };
  quants?: HfQuant[];
}

export interface PullJob {
  id: string;
  spec: string;
  status: 'queued' | 'active' | 'done' | 'error';
  modelId?: string;
  error?: string;
  progress?: {
    phase?: string;
    receivedBytes?: number;
    totalBytes?: number;
    speedBytesPerSec?: number;
    fileIndex?: number;
    fileCount?: number;
  };
}

export type HfSort = 'trending' | 'downloads' | 'likes' | 'updated';
export type HfSizeFilter = 'all' | 'small' | 'mid' | 'large' | 'fit';
export type HfTypeFilter = 'all' | 'text' | 'vision' | 'code';

export const hf = $state({
  query: '',
  author: '' as string, // sticky scope — search filters WITHIN this creator
  authorInfo: null as HfAuthor | null,
  sort: 'trending' as HfSort,
  fsize: 'all' as HfSizeFilter,
  ftype: 'all' as HfTypeFilter,
  results: [] as HfResult[],
  nextCursor: null as string | null,
  loading: false,
  error: '',
  selectedRepo: null as string | null,
  detail: null as HfDetail | null,
  detailLoading: false,
  detailError: '',
  // download tray
  jobs: [] as PullJob[],
  pulling: false,
  trayMsg: '',
  trayMsgKind: '' as '' | 'ok' | 'error',
});

export const QUICK_PICKS = ['Qwen3', 'Llama 3', 'Gemma', 'DeepSeek R1', 'Mistral', 'Phi'];
export const POPULAR_AUTHORS = ['bartowski', 'unsloth', 'Qwen', 'mradermacher', 'google', 'lmstudio-community'];

// ── Derivations shared by cards + filters ────────────────────────────────────

export const authorOf = (id: string): string => (id.includes('/') ? id.split('/')[0] : '');
export const repoOf = (id: string): string => (id.includes('/') ? id.split('/').slice(1).join('/') : id);
export const paramSize = (id: string): string | null => {
  const m = id.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  return m ? `${m[1]}B` : null;
};
const paramCount = (id: string): number | null => {
  const m = id.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  return m ? parseFloat(m[1]) : null;
};
const estQ4Bytes = (params: number): number => params * 0.6 * 1e9; // rough Q4_K_M weights

export const fmtBytes = (n: number | undefined): string => {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
export const fmtCount = (n: number | undefined): string =>
  !n ? '0' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
export const relativeTime = (iso: string | undefined): string => {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 86400000;
  if (isNaN(d) || d < 0) return '';
  if (d < 1) return 'today';
  if (d < 30) return `${Math.round(d)}d ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${(d / 365).toFixed(1)}y ago`;
};
export const fmtParams = (n: number | undefined): string | null => {
  if (!n) return null;
  const b = n / 1e9;
  if (b < 1) return `${Math.round(n / 1e6)}M`;
  return `${(b >= 100 ? b.toFixed(0) : b.toFixed(1)).replace(/\.0$/, '')}B`;
};
export const fmtCtx = (n: number | undefined): string | null =>
  !n ? null : n >= 1024 ? `${Math.round(n / 1024)}K` : String(n);

// Rough quick-triage GPU fit (Q4 weights vs VRAM); per-quant precision lives
// in the detail pane via the server's annotateFit.
export const fitInfo = (size: number, vram: number): { cls: string; label: string } => {
  const r = size / vram;
  if (r < 0.65) return { cls: 'fits', label: 'fits' };
  if (r < 0.88) return { cls: 'tight', label: 'tight' };
  return { cls: 'toobig', label: 'partial offload' };
};
export const quickFit = (id: string): { cls: string; label: string } | null => {
  const vram = local.status?.vramTotalBytes ?? 0;
  const p = paramCount(id);
  if (p == null || !vram) return null;
  return fitInfo(estQ4Bytes(p), vram);
};

export interface Badge { cls: string; label: string }

// Capability badges from id + tags + pipeline tag heuristics.
export function deriveBadges(m: { id: string; tags?: string[]; pipelineTag?: string }): Badge[] {
  const id = m.id.toLowerCase();
  const tags = (m.tags ?? []).map((t) => String(t).toLowerCase());
  const pt = (m.pipelineTag ?? '').toLowerCase();
  const out: Badge[] = [];
  const ps = paramSize(m.id);
  if (ps) out.push({ cls: 'size', label: ps });
  if (/instruct|-it\b|-it-|chat/.test(id) || tags.includes('conversational')) out.push({ cls: 'instruct', label: 'instruct' });
  if (/(^|[^a-z])(vl|vision)([^a-z]|$)/.test(id) || pt.includes('image-text') || tags.some((t) => t.includes('image-text') || t.includes('multimodal'))) out.push({ cls: 'vision', label: 'vision' });
  if (/\bmoe\b|[-_]a\d+b\b/.test(id) || tags.includes('moe')) out.push({ cls: 'moe', label: 'MoE' });
  if (/r1|qwq|reason|think|deepseek-r1/.test(id) || tags.includes('reasoning')) out.push({ cls: 'reasoning', label: 'reasoning' });
  if (/coder|code/.test(id) || tags.includes('code')) out.push({ cls: 'coder', label: 'coder' });
  if (/abliterat|uncensor|heretic/.test(id)) out.push({ cls: 'abliterated', label: 'uncensored' });
  return out;
}

const matchesType = (m: HfResult, ftype: HfTypeFilter): boolean => {
  if (ftype === 'all') return true;
  const cls = deriveBadges(m).map((b) => b.cls);
  if (ftype === 'vision') return cls.includes('vision');
  if (ftype === 'code') return cls.includes('coder');
  return !cls.includes('vision') && !cls.includes('coder'); // text
};
const matchesSize = (m: HfResult, fsize: HfSizeFilter, vram: number): boolean => {
  if (fsize === 'all') return true;
  const p = paramCount(m.id);
  if (p == null) return false;
  if (fsize === 'small') return p < 8;
  if (fsize === 'mid') return p >= 8 && p <= 30;
  if (fsize === 'large') return p > 30;
  return !vram || estQ4Bytes(p) < vram * 0.88; // fit
};

// The fetched batch filtered client-side (size/type chips don't refetch).
export function filteredResults(): HfResult[] {
  const vram = local.status?.vramTotalBytes ?? 0;
  return hf.results.filter((m) => matchesSize(m, hf.fsize, vram) && matchesType(m, hf.ftype));
}

export function installedRepos(): Set<string> {
  return new Set((local.status?.models ?? []).map((m) => m.source).filter(Boolean) as string[]);
}
export function installedFiles(): Set<string> {
  return new Set((local.status?.models ?? []).map((m) => (m.file ?? '').split(/[\\/]/).pop() ?? ''));
}

// ── Search / browse / author / detail ────────────────────────────────────────

let seq = 0; // monotonic — drops out-of-order responses during fast typing

export async function runSearch(append = false): Promise<void> {
  const mySeq = append ? seq : ++seq;
  if (!append) {
    hf.nextCursor = null;
    hf.error = '';
  }
  hf.loading = true;
  try {
    const params = new URLSearchParams();
    if (hf.query.trim()) params.set('q', hf.query.trim());
    if (hf.author) params.set('author', hf.author);
    params.set('sort', hf.sort);
    params.set('limit', '40');
    if (append && hf.nextCursor) params.set('cursor', hf.nextCursor);
    const r = await fetch(`/api/local/hf/search?${params.toString()}`);
    const j = (await r.json()) as { results?: HfResult[]; nextCursor?: string; error?: string };
    if (mySeq !== seq) return; // superseded
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    hf.nextCursor = j.nextCursor ?? null;
    hf.results = append ? [...hf.results, ...(j.results ?? [])] : (j.results ?? []);
  } catch (e) {
    if (mySeq === seq && !append) {
      hf.results = [];
      hf.error = e instanceof Error ? e.message : String(e);
    }
  } finally {
    if (mySeq === seq) hf.loading = false;
  }
}

// Landing = live trending feed, no query, detail pane placeholdered.
export function showLanding(): void {
  hf.selectedRepo = null;
  hf.detail = null;
  hf.detailError = '';
  clearAuthorScope();
  hf.query = '';
  hf.sort = 'trending';
  void runSearch();
}

export function clearAuthorScope(): void {
  hf.author = '';
  hf.authorInfo = null;
}

export async function enterAuthor(name: string): Promise<void> {
  hf.author = name;
  hf.authorInfo = { name }; // placeholder header until the profile lands
  hf.query = '';
  void runSearch();
  try {
    const r = await fetch(`/api/local/hf/author?name=${encodeURIComponent(name)}`);
    const j = (await r.json()) as { author?: HfAuthor };
    if (j.author && hf.author === name) hf.authorInfo = j.author;
  } catch {
    // keep the placeholder header
  }
}

export async function openDetail(repo: string): Promise<void> {
  hf.selectedRepo = repo;
  hf.detail = null;
  hf.detailError = '';
  hf.detailLoading = true;
  try {
    const r = await fetch(`/api/local/hf/model?repo=${encodeURIComponent(repo)}`);
    const j = (await r.json()) as HfDetail & { error?: string };
    if (hf.selectedRepo !== repo) return; // superseded by another click
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    hf.detail = j;
  } catch (e) {
    if (hf.selectedRepo === repo) hf.detailError = e instanceof Error ? e.message : String(e);
  } finally {
    if (hf.selectedRepo === repo) hf.detailLoading = false;
  }
}

// ── Download queue (sequential server-side; polled tray) ────────────────────

let pollHandle: ReturnType<typeof setInterval> | null = null;
const seenDone = new Set<string>();

export async function startPull(spec: string, opts: { noTools?: boolean; reasoning?: boolean; supportsTools?: boolean } = {}): Promise<void> {
  hf.trayMsg = '';
  hf.trayMsgKind = '';
  try {
    const r = await fetch('/api/local/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec, noTools: !!opts.noTools, reasoning: opts.reasoning, supportsTools: opts.supportsTools }),
    });
    const j = (await r.json()) as { error?: string };
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    hf.trayMsg = `queued ${spec} - downloads keep running while you browse.`;
    hf.trayMsgKind = 'ok';
    startPullPoll();
  } catch (e) {
    hf.trayMsg = `couldn't queue: ${e instanceof Error ? e.message : e}`;
    hf.trayMsgKind = 'error';
  }
}

export function startPullPoll(): void {
  if (pollHandle) return;
  pollHandle = setInterval(() => {
    void (async () => {
      let res: { pulling?: boolean; jobs?: PullJob[] };
      try {
        res = (await (await fetch('/api/local/pull/status')).json()) as typeof res;
      } catch {
        return; // transient — keep polling
      }
      hf.jobs = res.jobs ?? [];
      hf.pulling = res.pulling === true;
      // Once per newly-finished job: refresh the registry so installed
      // markers + the settings modal + the picker all see the new model.
      let finished = false;
      for (const j of hf.jobs) {
        if (j.status === 'done' && !seenDone.has(j.id)) {
          seenDone.add(j.id);
          finished = true;
        }
      }
      if (finished) void fetchLocalStatus();
      if (!hf.pulling && pollHandle) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
    })();
  }, 700);
}

export function stopPullPoll(): void {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

// Resume the tray if a pull is still running from a previous open.
export async function resumeTrayIfPulling(): Promise<void> {
  try {
    const r = await fetch('/api/local/pull/status');
    const j = (await r.json()) as { pulling?: boolean; jobs?: PullJob[] };
    hf.jobs = j.jobs ?? [];
    hf.pulling = j.pulling === true;
    if (hf.pulling) startPullPoll();
  } catch {
    // ignore
  }
}
