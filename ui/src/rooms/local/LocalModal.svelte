<script lang="ts">
  // Local-model settings — the port of ui/local.js's settings overlay:
  // model select + runtime actions (load/unload/default/delete/reset/
  // recommend), sampling, tool exposure (mode + custom checklist), context
  // budget, spawn knobs, and the predictive VRAM meter. Mounted keyed per
  // open (LocalHost), so field state seeds once per open.
  import Modal from '../../components/Modal.svelte';
  import Button from '../../components/Button.svelte';
  import TuneSlider from '../../components/TuneSlider.svelte';
  import MeterBar from './MeterBar.svelte';
  import { confirmDialog } from '../../components/confirm.svelte';
  import { ui, prefs } from '../../lib/state.svelte';
  import {
    local, fetchLocalStatus, loadModel, unloadModel, deleteModel, makeDefault,
    saveModelPatch, resetModel, fetchRecommended, ensureToolCatalog,
    isLocalSelected, toolCategory, CORE_TOOLS_UI, READONLY_TOOLS_UI,
    type LocalModelEntry, type ToolDef,
  } from './local.svelte';
  import type { MeterSegment } from './MeterBar.svelte';

  let { onclose }: { onclose: () => void } = $props();

  // ── Selection + field state ─────────────────────────────────────────────
  let modelId = $state('');
  let temperature = $state(0.7);
  let topP = $state(0.95);
  let minP = $state(0.05);
  let repeatPenalty = $state(1.1);
  let topK = $state(40);
  let maxTokens = $state(0);
  let ctxSize = $state(0);
  let gpuLayers = $state(-1);
  let threads = $state(0);
  let kvCacheType = $state('f16');
  let flashAttn = $state('auto');
  let toolMode = $state('core');
  let prevToolMode = 'core';
  let checked = $state<Set<string>>(new Set());
  let reasoning = $state(false);

  let toolCatalog = $state<ToolDef[]>([]);
  let promptTokens = $state<Record<string, number> | null>(null);
  let msg = $state('');
  let msgKind = $state<'' | 'ok' | 'error' | 'pending'>('');
  let busy = $state(false);

  const status = $derived(local.status);
  const models = $derived(status?.models ?? []);
  const defaults = $derived((status?.defaults ?? {}) as Record<string, number | string>);
  const entry = $derived(models.find((m) => m.id === modelId) ?? ({} as LocalModelEntry));

  const num = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
  const str = (v: unknown, fb: string): string => (typeof v === 'string' && v ? v : fb);

  function setMsg(t: string, kind: '' | 'ok' | 'error' | 'pending' = ''): void {
    msg = t;
    msgKind = kind;
  }

  // Seed everything once on mount: status + tool catalog + prompt breakdown,
  // opening on the model active in the backend picker (when local is live).
  $effect(() => {
    void (async () => {
      toolCatalog = await ensureToolCatalog();
      await fetchLocalStatus();
      const ids = (local.status?.models ?? []).map((m) => m.id);
      const want = (isLocalSelected() && prefs.model && ids.includes(prefs.model) && prefs.model)
        || (local.status?.defaultModelId && ids.includes(local.status.defaultModelId) && local.status.defaultModelId)
        || ids[0] || '';
      if (want) selectModel(want);
      if (ui.currentAgentId) {
        try {
          const r = await fetch(`/api/agents/${encodeURIComponent(ui.currentAgentId)}/system-prompt-preview`);
          const j = (await r.json()) as { meta?: { tokens?: Record<string, number> } };
          promptTokens = j.meta?.tokens ?? null;
        } catch { /* budget shows the tools-only hint */ }
      }
    })();
  });

  function selectModel(id: string): void {
    modelId = id;
    const e = (local.status?.models ?? []).find((m) => m.id === id) ?? ({} as LocalModelEntry);
    const d = (local.status?.defaults ?? {}) as Record<string, number | string>;
    temperature = num(e.temperature, num(d.temperature, 0.7));
    topP = num(e.topP, num(d.topP, 0.95));
    minP = num(e.minP, num(d.minP, 0.05));
    repeatPenalty = num(e.repeatPenalty, num(d.repeatPenalty, 1.1));
    topK = num(e.topK, num(d.topK, 40));
    maxTokens = num(e.maxTokens, num(d.maxTokens, 0));
    ctxSize = num(e.ctxSize, num(d.ctxSize, 0));
    gpuLayers = num(e.gpuLayers, num(d.gpuLayers, -1));
    threads = num(e.threads, num(d.threads, 0));
    kvCacheType = str(e.kvCacheType, str(d.kvCacheType, 'f16'));
    flashAttn = str(e.flashAttn, str(d.flashAttn, 'auto'));
    toolMode = e.toolMode ?? (e.supportsTools === false ? 'off' : str(d.toolMode, 'core'));
    prevToolMode = toolMode;
    checked = new Set(e.allowedTools ?? []);
    if (toolMode === 'custom' && !e.allowedTools) seedChecklist('core');
    reasoning = !!e.reasoning;
    setMsg('');
  }

  // ── Spawn-knob interplay ────────────────────────────────────────────────
  // Quantized KV cache requires flash attention — lock FA on when KV ≠ f16
  // (the backend forces it; this keeps the UI honest about what'll run).
  const faLocked = $derived(kvCacheType !== 'f16');
  $effect(() => {
    if (faLocked) flashAttn = 'on';
  });

  // Context <select>: presets + a one-off option when the saved value is odd.
  const CTX_PRESETS = [0, 2048, 4096, 8192, 16384, 32768, 65536, 131072];
  const ctxOptions = $derived(CTX_PRESETS.includes(ctxSize) ? CTX_PRESETS : [...CTX_PRESETS, ctxSize]);
  const fmtCtxOpt = (v: number): string =>
    v === 0 ? 'Model max (default)'
      : CTX_PRESETS.includes(v) ? `${v / 1024}K · ${v.toLocaleString()}`
        : `${v.toLocaleString()} (custom)`;

  // ── Tool checklist + token math ─────────────────────────────────────────
  const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n || 0)));

  const toolCats = $derived.by(() => {
    const cats = new Map<string, ToolDef[]>();
    for (const t of toolCatalog) {
      const c = toolCategory(t.name);
      if (!cats.has(c)) cats.set(c, []);
      cats.get(c)!.push(t);
    }
    const order = ['Files', 'Shell', 'Web', 'Memory & research', 'Sessions', 'Cron', 'Attachments', 'Other'];
    return [...cats.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  });

  const toolTokens = $derived.by(() => {
    if (toolMode === 'off') return 0;
    const sum = (pred: (n: string) => boolean): number =>
      toolCatalog.reduce((a, t) => a + (pred(t.name) ? (t.estTokens ?? 0) : 0), 0);
    if (toolMode === 'all') return sum(() => true);
    if (toolMode === 'core') return sum((n) => CORE_TOOLS_UI.has(n));
    return sum((n) => checked.has(n));
  });

  function onToolModeChange(): void {
    if (toolMode === 'custom') {
      // Seed from the prior mode's effective set so "custom" starts honest.
      seedChecklist(prevToolMode === 'all' ? 'all' : prevToolMode === 'off' ? 'none' : 'core');
    }
    prevToolMode = toolMode;
  }

  function seedChecklist(preset: 'all' | 'core' | 'readonly' | 'none'): void {
    if (preset === 'all') checked = new Set(toolCatalog.map((t) => t.name));
    else if (preset === 'core') checked = new Set(toolCatalog.map((t) => t.name).filter((n) => CORE_TOOLS_UI.has(n)));
    else if (preset === 'readonly') checked = new Set(READONLY_TOOLS_UI);
    else checked = new Set();
  }

  function toggleTool(name: string): void {
    const next = new Set(checked);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    checked = next;
    toolMode = 'custom';
    prevToolMode = 'custom';
  }

  // ── Context budget (system prompt + tools vs the context window) ────────
  const budgetCtx = $derived.by(() => {
    if (status?.activeModelId === modelId && status?.activeContextTokens) return status.activeContextTokens;
    const cfg = ctxSize || num(defaults.ctxSize, 0);
    return cfg > 0 ? cfg : 0; // 0 = model max / unknown
  });

  const budgetSegs = $derived.by((): MeterSegment[] => {
    if (!promptTokens) return [];
    const t = promptTokens;
    return [
      { label: 'Identity + workspace', value: Math.max(0, (t.stable ?? 0) - (t.standingSkills ?? 0)), pretty: '' },
      { label: 'Skills', value: (t.standingSkills ?? 0) + (t.skillsCatalog ?? 0), pretty: '' },
      { label: 'Tools', value: toolTokens, pretty: '' },
      { label: 'Persona', value: t.persona ?? 0, pretty: '' },
      { label: 'Memory + misc', value: Math.max(0, (t.dynamic ?? 0) - (t.skillsCatalog ?? 0)), pretty: '' },
    ].filter((s) => s.value > 0).map((s) => ({ ...s, pretty: `~${fmtTok(s.value)}` }));
  });
  const budgetTotal = $derived(budgetSegs.reduce((a, s) => a + s.value, 0));
  const budgetLevel = $derived.by((): 'ok' | 'tight' | 'over' => {
    if (!budgetCtx) return 'ok';
    const pct = budgetTotal / budgetCtx;
    return pct >= 0.9 ? 'over' : pct >= 0.7 ? 'tight' : 'ok';
  });
  const budgetSummary = $derived(
    budgetCtx
      ? `~${fmtTok(budgetTotal)} / ${fmtTok(budgetCtx)} context (${Math.round((budgetTotal / budgetCtx) * 100)}%)${budgetTotal / budgetCtx >= 0.9 ? ' - over budget, trim tools/skills' : ''}`
      : `~${fmtTok(budgetTotal)} prompt tokens · set a context size to see headroom`,
  );

  // ── Predictive VRAM meter ───────────────────────────────────────────────
  const fmtGB = (n: number): string => `${(n / 1e9).toFixed(1)} GB`;
  const KV_FACTOR: Record<string, number> = { f16: 1, q8_0: 0.5, q4_0: 0.25 };
  const paramsFromId = (id: string): number => {
    const m = id.match(/(\d+(?:\.\d+)?)\s*b\b/i);
    return m ? parseFloat(m[1]) * 1e9 : 0;
  };
  // Mirror of pull.ts estimateKvBytes (GQA power-law) for live estimates.
  const kvBytes = (params: number, ctxTokens: number, kvType: string): number => {
    if (!params || !ctxTokens) return 0;
    return 11.36 * Math.pow(Math.max(0.1, params / 1e9), 0.785) * 1024 * ctxTokens * (KV_FACTOR[kvType] ?? 1);
  };

  const vramSegs = $derived.by((): MeterSegment[] => {
    const total = status?.vramTotalBytes ?? 0;
    const weights = entry.sizeBytes ?? 0;
    if (!total || !weights) return [];
    let ctxTokens = ctxSize;
    if (!ctxTokens && status?.activeModelId === modelId) ctxTokens = status.activeContextTokens ?? 0;
    const segs = [
      { label: 'System reserve', value: status?.reservedVramBytes ?? 2e9 },
      { label: 'Weights', value: weights },
      { label: ctxTokens ? `Context (${fmtTok(ctxTokens)} KV)` : 'Context', value: kvBytes(paramsFromId(modelId), ctxTokens, kvCacheType) },
      { label: 'Overhead', value: 0.7e9 + weights * 0.05 },
    ];
    return segs.filter((s) => s.value > 0).map((s) => ({ ...s, pretty: `~${fmtGB(s.value)}` }));
  });
  const vramUsed = $derived(vramSegs.reduce((a, s) => a + s.value, 0));
  const vramTotal = $derived(status?.vramTotalBytes ?? 0);
  const vramLevel = $derived.by((): 'ok' | 'tight' | 'over' =>
    vramUsed > vramTotal ? 'over' : vramUsed > vramTotal * 0.9 ? 'tight' : 'ok');
  const vramSummary = $derived(
    `~${fmtGB(vramUsed)} / ${fmtGB(vramTotal)} VRAM (${vramTotal ? Math.round((vramUsed / vramTotal) * 100) : 0}%)${vramUsed > vramTotal ? ' - exceeds VRAM (will spill to CPU / risk OOM)' : ''}`,
  );

  const statusLine = $derived.by(() => {
    const s = status;
    if (!s) return '';
    const dot = s.state === 'ready' ? '●' : s.state === 'loading' ? '◐' : '○';
    let line = `${dot} runtime ${s.state}`;
    if (s.activeModelId) line += ` · loaded: ${s.activeModelId}`;
    if (s.error) line += ` · ${s.error}`;
    return line;
  });

  // ── Actions ─────────────────────────────────────────────────────────────
  function readPatch(): Record<string, unknown> {
    const patch: Record<string, unknown> = {
      temperature, topP, minP, repeatPenalty,
      topK: Math.max(0, Math.trunc(topK || 0)),
      maxTokens: Math.max(0, Math.trunc(maxTokens || 0)),
      ctxSize: Math.max(0, Math.trunc(ctxSize || 0)),
      gpuLayers: Number.isFinite(gpuLayers) ? Math.trunc(gpuLayers) : -1,
      threads: Math.max(0, Math.trunc(threads || 0)),
      kvCacheType, flashAttn, toolMode, reasoning,
    };
    if (toolMode === 'custom') patch.allowedTools = [...checked];
    return patch;
  }

  async function run(label: string, fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string): Promise<void> {
    busy = true;
    setMsg(`${label}…`, 'pending');
    const res = await fn();
    busy = false;
    if (res.ok) setMsg(okMsg, 'ok');
    else setMsg(`${label} failed: ${res.error}`, 'error');
  }

  const onSave = (): Promise<void> => run('saving', () => saveModelPatch(modelId, readPatch()),
    'saved - sampling & tools apply on your next message; ctx / GPU / threads need a reload (Unload, then send).');
  const onLoad = (): Promise<void> => run(`loading ${modelId} (cold load can take a while)`, () => loadModel(modelId), 'loaded.');
  const onUnload = (): Promise<void> => run('unloading', () => unloadModel(), 'unloaded - VRAM freed.');
  const onDefault = (): Promise<void> => run('saving', () => makeDefault(modelId), `"${modelId}" is now the default.`);
  const onReset = async (): Promise<void> => {
    await run('resetting', () => resetModel(modelId), 'reset to defaults.');
    selectModel(modelId);
  };

  async function onDelete(): Promise<void> {
    const ok = await confirmDialog({
      title: 'Delete model',
      message: `Delete "${modelId}" and its GGUF file from disk?\n\nThis frees the disk space and removes it from the model list. It can't be undone - but you can always re-pull it.`,
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await run('deleting', () => deleteModel(modelId), `deleted "${modelId}".`);
    const ids = (local.status?.models ?? []).map((m) => m.id);
    if (ids.length) selectModel(local.status?.defaultModelId && ids.includes(local.status.defaultModelId) ? local.status.defaultModelId : ids[0]);
    else modelId = '';
  }

  // Size context + KV to the GPU's free VRAM right now — previews into the
  // controls; the user reviews the rationale and clicks Save to apply.
  async function onRecommend(): Promise<void> {
    busy = true;
    setMsg('sizing to your GPU…', 'pending');
    const res = await fetchRecommended(modelId);
    busy = false;
    if (!res.ok || !res.rec) { setMsg(`couldn't compute: ${res.error}`, 'error'); return; }
    const j = res.rec;
    let sampled = false;
    if (typeof j.temperature === 'number') { temperature = j.temperature; sampled = true; }
    if (typeof j.topP === 'number') { topP = j.topP; sampled = true; }
    if (typeof j.minP === 'number') { minP = j.minP; sampled = true; }
    if (typeof j.repeatPenalty === 'number') { repeatPenalty = j.repeatPenalty; sampled = true; }
    if (typeof j.topK === 'number') { topK = j.topK; sampled = true; }
    if (j.ctxSize) {
      ctxSize = j.ctxSize;
      kvCacheType = j.kvCacheType || 'f16';
      flashAttn = j.flashAttn || 'auto';
      if (Number.isFinite(j.gpuLayers)) gpuLayers = j.gpuLayers!;
      setMsg(`${j.rationale} - review & Save to apply (needs a reload).`, 'ok');
    } else {
      setMsg(`${j.rationale}${sampled ? '  (Sampling sliders updated; context not sized - weights exceed usable VRAM.)' : ''}`, 'error');
    }
  }

  const dModified = (key: string, v: number): boolean => {
    const d = defaults[key];
    return typeof d === 'number' && Math.abs(v - d) > 1e-9;
  };
</script>

<Modal open title="Local Models" size="lg" tall onclose={onclose}>
  <div class="form">
    {#if !status}
      <div class="muted">Loading runtime status…</div>
    {:else if !status.hasBinary}
      <div class="error">⚠ llama-server not found - drop the CUDA build in local/bin/</div>
    {:else if models.length === 0}
      <div class="muted">No models yet - add one from HuggingFace.</div>
      <div><Button variant="primary" onclick={() => (local.browserOpen = true)}>+ Add model</Button></div>
    {:else}
      <div class="row">
        <label class="field">
          <span>Model</span>
          <select bind:value={modelId} onchange={() => selectModel(modelId)}>
            {#each models as m (m.id)}
              <option value={m.id}>{m.id}{status.defaultModelId === m.id ? ' (default)' : ''}</option>
            {/each}
          </select>
        </label>
        <div class="field add-field">
          <span>&nbsp;</span>
          <Button variant="ghost" onclick={() => (local.browserOpen = true)}>+ Add model</Button>
        </div>
      </div>

      <div class="status-line">{statusLine}</div>

      <div class="actions">
        <Button variant="ghost" disabled={busy} onclick={() => void onLoad()}>Load</Button>
        <Button variant="ghost" disabled={busy} onclick={() => void onUnload()}>Unload</Button>
        <Button variant="ghost" disabled={busy} onclick={() => void onDefault()}>Make default</Button>
        <Button variant="ghost" disabled={busy} onclick={() => void onRecommend()}>Set recommended</Button>
        <Button variant="ghost" disabled={busy} onclick={() => void onReset()}>Reset</Button>
        <Button variant="danger" disabled={busy} onclick={() => void onDelete()}>Delete…</Button>
      </div>

      <div class="section">Sampling</div>
      <TuneSlider bind:value={temperature} label="Temperature" min={0} max={2} step={0.05}
        hint="Lower = steadier, fewer odd tokens. 0.4-0.6 tames small-model glitches; 0.7 default; 1.0+ wilder."
        modified={dModified('temperature', temperature)} />
      <TuneSlider bind:value={topP} label="top_p (nucleus)" min={0} max={1} step={0.01}
        hint="Keep tokens within the top p cumulative probability. 0.9-0.95 typical."
        modified={dModified('topP', topP)} />
      <TuneSlider bind:value={minP} label="min_p" min={0} max={0.5} step={0.01}
        hint="Floor on a token's probability relative to the top token. Raise (0.1+) to cut the rare garbage tokens."
        modified={dModified('minP', minP)} />
      <TuneSlider bind:value={repeatPenalty} label="repeat penalty" min={1} max={1.5} step={0.01}
        hint="Discourages repetition. 1.0 = off, 1.1 = mild (default), 1.3+ can hurt coherence."
        modified={dModified('repeatPenalty', repeatPenalty)} />
      <div class="row">
        <label class="field">
          <span>top_k (0 = off)</span>
          <input type="number" min="0" step="1" bind:value={topK} />
        </label>
        <label class="field">
          <span>Max reply tokens (0 = no cap)</span>
          <input type="number" min="0" step="1" bind:value={maxTokens} />
        </label>
      </div>

      <div class="section">Tools</div>
      <div class="row">
        <label class="field">
          <span>Tool exposure</span>
          <select bind:value={toolMode} onchange={onToolModeChange}>
            <option value="off">Off - chat only</option>
            <option value="core">Core - curated ~14-tool subset</option>
            <option value="all">All registered tools</option>
            <option value="custom">Custom checklist</option>
          </select>
        </label>
        <label class="check reasoning-check">
          <input type="checkbox" bind:checked={reasoning} />
          <span>Reasoning model (split inline &lt;think&gt;)</span>
        </label>
      </div>
      {#if toolMode === 'custom'}
        <div class="tool-presets">
          <button class="preset" type="button" onclick={() => seedChecklist('none')}>None</button>
          <button class="preset" type="button" onclick={() => seedChecklist('readonly')}>Read-only</button>
          <button class="preset" type="button" onclick={() => seedChecklist('core')}>Core</button>
          <button class="preset" type="button" onclick={() => seedChecklist('all')}>All</button>
          <span class="count">{checked.size} tool{checked.size === 1 ? '' : 's'} · ~{fmtTok(toolTokens)} tokens</span>
        </div>
        <div class="tool-list">
          {#each toolCats as [cat, tools] (cat)}
            <div class="tool-cat">{cat}</div>
            {#each tools as t (t.name)}
              <label class="tool-row" title={t.description ?? ''}>
                <input type="checkbox" checked={checked.has(t.name)} onchange={() => toggleTool(t.name)} />
                <span class="tool-name">{t.name}</span>
                <span class="tool-tok">~{fmtTok(t.estTokens ?? 0)}</span>
              </label>
            {/each}
          {/each}
        </div>
      {/if}

      <div class="section">Context budget</div>
      {#if budgetSegs.length}
        <MeterBar segments={budgetSegs} total={budgetCtx} summary={budgetSummary} level={budgetLevel}
          hint="System prompt before any conversation. Tools trim above; workspace headings & skills toggle per-agent." />
      {:else}
        <div class="hint">Tools add ~{fmtTok(toolTokens)} tokens per request. (Prompt breakdown unavailable.)</div>
      {/if}

      <div class="section">Context &amp; GPU (spawn - reload to apply)</div>
      <div class="row">
        <label class="field">
          <span>Context size</span>
          <select bind:value={ctxSize}>
            {#each ctxOptions as v (v)}
              <option value={v}>{fmtCtxOpt(v)}</option>
            {/each}
          </select>
        </label>
        <label class="field">
          <span>GPU layers (-1 = all)</span>
          <input type="number" min="-1" step="1" bind:value={gpuLayers} />
        </label>
      </div>
      <div class="row">
        <label class="field">
          <span>Threads (0 = auto)</span>
          <input type="number" min="0" step="1" bind:value={threads} />
        </label>
        <label class="field">
          <span>KV cache type</span>
          <select bind:value={kvCacheType}>
            <option value="f16">f16 (full)</option>
            <option value="q8_0">q8_0 (half VRAM)</option>
            <option value="q4_0">q4_0 (quarter VRAM)</option>
          </select>
        </label>
        <label class="field">
          <span>Flash attention</span>
          <select bind:value={flashAttn} disabled={faLocked} title={faLocked ? 'Quantized KV cache requires flash attention' : ''}>
            <option value="auto">auto</option>
            <option value="on">on</option>
            <option value="off">off</option>
          </select>
        </label>
      </div>

      {#if vramSegs.length}
        <MeterBar segments={vramSegs} total={vramTotal} summary={vramSummary} level={vramLevel}
          hint="Predicted for this model at the selected context. Bump context / KV-cache type and watch it move." />
      {:else}
        <div class="hint">VRAM estimate needs a detected GPU + a known model size.</div>
      {/if}
    {/if}

    {#if msg}<div class="msg {msgKind}">{msg}</div>{/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={onclose}>Close</Button>
    <span class="spacer"></span>
    <Button variant="primary" disabled={busy || !modelId} onclick={() => void onSave()}>Save</Button>
  {/snippet}
</Modal>

<style>
  .muted { color: var(--text-muted); font-size: 14px; }

  .add-field { flex: 0 0 auto; }
  .add-field > span { font-size: 12px; }

  .status-line { font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); }

  .actions { display: flex; flex-wrap: wrap; gap: 6px; }

  .reasoning-check { align-self: flex-end; padding-bottom: 7px; flex: 1; }

  .tool-presets { display: flex; align-items: center; gap: 6px; }
  .preset {
    padding: 3px 9px;
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    font-family: var(--font-display);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .preset:hover { border-color: var(--accent); color: var(--accent); }
  .count { margin-left: auto; font-family: var(--font-mono); font-size: 12px; color: var(--text-muted); }

  .tool-list {
    max-height: 220px;
    overflow-y: auto;
    border: 1px solid var(--border);
    padding: 6px 9px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tool-cat {
    font-family: var(--font-display);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--accent);
    margin-top: 6px;
  }
  .tool-cat:first-child { margin-top: 0; }
  .tool-row { display: flex; align-items: center; gap: 7px; font-size: 13px; cursor: pointer; }
  .tool-row input { accent-color: var(--accent); }
  .tool-name { font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); }
  .tool-tok { margin-left: auto; font-family: var(--font-mono); font-size: 12px; color: var(--text-muted); }

  .msg { font-size: 13px; color: var(--text-secondary); }
  .msg.ok { color: var(--success); }
  .msg.error { color: var(--error); }
  .msg.pending { color: var(--warning); }

  .spacer { flex: 1; }
</style>
