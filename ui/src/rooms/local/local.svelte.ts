// Local-models room — the llama.cpp runtime chrome. State + REST for the
// settings modal (sampling / tools / context / VRAM, load/unload/default/
// delete/reset/recommend), the profile-bar status chip, per-turn telemetry
// (TTFT + tok/s), and the pull queue + HuggingFace browser endpoints.
// Spec: ui/local.js + app.js's local status/telemetry layer.
import { prefs, serverConfig } from '../../lib/state.svelte';
import { onWsEvent, onTurnOptions, type WsEvent } from '../../lib/ws';

// Registry entry (local/registry.json shape, loose external JSON).
export interface LocalModelEntry {
  id: string;
  file?: string;
  name?: string;
  source?: string;
  quant?: string;
  sizeBytes?: number;
  pulledAt?: string;
  // spawn overrides
  ctxSize?: number;
  gpuLayers?: number;
  threads?: number;
  kvCacheType?: string;
  flashAttn?: string;
  // sampling
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  maxTokens?: number;
  // capabilities
  toolMode?: string;
  allowedTools?: string[];
  reasoning?: boolean;
  supportsTools?: boolean;
}

export interface LocalStatus {
  enabled: boolean;
  hasBinary: boolean;
  binaryPath?: string;
  baseUrl?: string;
  state: 'idle' | 'loading' | 'ready' | 'failed';
  activeModelId: string | null;
  activeContextTokens?: number;
  error: string | null;
  defaultModelId: string | null;
  models: LocalModelEntry[];
  vramTotalBytes?: number;
  reservedVramBytes?: number;
  defaults?: Record<string, number | string>;
}

// Last local turn's telemetry: timing stamped client-side on text deltas,
// token counts from message_end usage (tok/s prefers llama-server's own
// measured rate — the client estimate over-reads on short bursty replies).
export interface LocalTurnStats {
  promptTokens: number;
  tokPerSec: number;
  ttftMs: number;
}

export const local = $state({
  status: null as LocalStatus | null,
  open: false, // settings modal
  browserOpen: false, // HF browser modal
  stats: null as LocalTurnStats | null,
});

export function isLocalSelected(): boolean {
  return prefs.backendId === 'local';
}

// ── Status + catalog sync ────────────────────────────────────────────────────

export async function fetchLocalStatus(): Promise<LocalStatus | null> {
  try {
    const r = await fetch('/api/local/status');
    if (!r.ok) { local.status = null; return null; }
    local.status = (await r.json()) as LocalStatus;
    syncCatalog(local.status);
    return local.status;
  } catch {
    local.status = null;
    return null;
  }
}

// Mirror registry changes (pull/delete/default) into the backend catalog so
// the BackendPicker's local cell shows fresh models without a page reload —
// the Svelte port of app.js syncLocalModelsToSelector.
function syncCatalog(status: LocalStatus): void {
  const cell = serverConfig.backends.find((b) => b.id === 'local');
  if (!cell) return;
  cell.models = (status.models ?? []).map((m) => m.id);
  if (status.defaultModelId) cell.defaultModel = status.defaultModelId;
}

// ── Runtime + registry actions (modal consumers show the returned error) ────

export interface ActionResult {
  ok: boolean;
  error?: string;
}

async function jsonAction(url: string, init?: RequestInit): Promise<ActionResult & { data?: Record<string, unknown> }> {
  try {
    const r = await fetch(url, init);
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    if (!r.ok) return { ok: false, error: data.error ?? `HTTP ${r.status}` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  ...(body !== undefined
    ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {}),
});

// Warm a model (blocks server-side until healthy — cold loads take seconds).
export async function loadModel(id: string): Promise<ActionResult> {
  const res = await jsonAction('/api/local/load', post({ model: id }));
  await fetchLocalStatus();
  return res;
}

export async function unloadModel(): Promise<ActionResult> {
  const res = await jsonAction('/api/local/unload', post());
  await fetchLocalStatus();
  return res;
}

export async function deleteModel(id: string): Promise<ActionResult & { fileDeleted?: boolean }> {
  const res = await jsonAction(`/api/local/models/${encodeURIComponent(id)}?deleteFile=true`, { method: 'DELETE' });
  await fetchLocalStatus();
  return { ...res, fileDeleted: res.data?.fileDeleted === true };
}

export async function makeDefault(id: string): Promise<ActionResult> {
  const res = await jsonAction(`/api/local/models/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ makeDefault: true }),
  });
  await fetchLocalStatus();
  return res;
}

export async function saveModelPatch(id: string, patch: Record<string, unknown>): Promise<ActionResult> {
  const res = await jsonAction(`/api/local/models/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  await fetchLocalStatus();
  return res;
}

export const resetModel = (id: string): Promise<ActionResult> => saveModelPatch(id, { reset: true });

// GPU-sized spawn settings for the "Set recommended" button — measures live
// free VRAM, so it accounts for whatever else (voice models…) is loaded.
export interface Recommended {
  ctxSize?: number;
  kvCacheType?: string;
  flashAttn?: string;
  gpuLayers?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  rationale?: string;
}

export async function fetchRecommended(id: string): Promise<(ActionResult & { rec?: Recommended })> {
  const res = await jsonAction(`/api/local/models/${encodeURIComponent(id)}/recommended`);
  if (!res.ok) return res;
  return { ok: true, rec: res.data as Recommended };
}

// ── Tool catalog (/api/tools — checklist + context-budget math) ─────────────

export interface ToolDef {
  name: string;
  description?: string;
  estTokens?: number;
}

let toolCatalogCache: ToolDef[] = [];

export async function ensureToolCatalog(): Promise<ToolDef[]> {
  if (toolCatalogCache.length) return toolCatalogCache;
  try {
    const r = await fetch('/api/tools');
    const j = (await r.json()) as { tools?: ToolDef[] };
    toolCatalogCache = j.tools ?? [];
  } catch {
    // leave empty — the checklist just won't populate
  }
  return toolCatalogCache;
}

// The curated subset the backend's "core" toolMode exposes (~14 tools — the
// full surface overflows llama.cpp's tool grammar).
export const CORE_TOOLS_UI = new Set([
  'read_file', 'write_file', 'edit_file', 'list_directory', 'glob_files', 'grep_files',
  'bash', 'web_fetch', 'remember', 'recall', 'recall_source', 'memory_status',
  'sessions_list', 'sessions_history',
]);
export const READONLY_TOOLS_UI = ['read_file', 'list_directory', 'glob_files', 'grep_files'];

export function toolCategory(name: string): string {
  if (['read_file', 'write_file', 'edit_file', 'list_directory', 'glob_files', 'grep_files'].includes(name)) return 'Files';
  if (name === 'bash') return 'Shell';
  if (name === 'web_fetch') return 'Web';
  if (/^(remember|recall|memory_status)/.test(name) || name.startsWith('englyph_')) return 'Memory & research';
  if (name.startsWith('sessions_') || name === 'render_session_markdown') return 'Sessions';
  if (name.startsWith('cron')) return 'Cron';
  if (name.startsWith('attach_')) return 'Attachments';
  return 'Other';
}

// ── Per-turn telemetry (TTFT / tok/s for the status chip) ───────────────────

let timing: { sentAt: number; firstAt: number; lastAt: number } | null = null;

function onTelemetryEvent(ev: WsEvent): void {
  if (ev.type === 'text_delta') {
    // Stamp first/last token times. Deliberately NOT on thinking deltas —
    // the cold-load keep-alive emits those, which would skew TTFT.
    if (!timing) return;
    const now = performance.now();
    if (!timing.firstAt) timing.firstAt = now;
    timing.lastAt = now;
    return;
  }
  // message_end — fold client timing + server usage into the last-turn stats.
  const t = timing;
  timing = null;
  if (!t || !t.firstAt) return; // nothing streamed (tool-only / empty turn)
  const usage = (ev.usage ?? {}) as { inputTokens?: number; outputTokens?: number; tokensPerSec?: number };
  const out = usage.outputTokens ?? 0;
  const genSec = Math.max(0.001, (t.lastAt - t.firstAt) / 1000);
  local.stats = {
    promptTokens: usage.inputTokens ?? 0,
    tokPerSec: usage.tokensPerSec ?? (out > 0 ? out / genSec : 0),
    ttftMs: Math.max(0, t.firstAt - t.sentAt),
  };
}

// ── Registration (idempotent; called from LocalHost) ────────────────────────

let registered = false;

export function registerLocal(): void {
  if (registered) return;
  registered = true;
  // Outbound seam doubles as the send-time hook: a local turn starts the
  // telemetry clock (the decorator adds no payload fields).
  onTurnOptions(() => {
    timing = isLocalSelected() ? { sentAt: performance.now(), firstAt: 0, lastAt: 0 } : null;
  });
  // Observers (claim:false) — core dispatch still handles both events.
  onWsEvent((type) => type === 'text_delta' || type === 'message_end', onTelemetryEvent, { claim: false });
}
