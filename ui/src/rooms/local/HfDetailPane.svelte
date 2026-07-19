<script lang="ts">
  // HF model detail: header (author link + HF link), capability chips, spec
  // strip, quant table (server-annotated fit + recommended pick + pull), and
  // the README through the shared smd renderer (XSS-safe — raw HTML stays
  // literal).
  import { renderStatic } from '../../lib/stream';
  import {
    hf, deriveBadges, authorOf, repoOf, fmtCount, fmtBytes, fmtParams, fmtCtx,
    relativeTime, installedFiles, startPull, enterAuthor, type HfDetail,
  } from './hf.svelte';
  import { local } from './local.svelte';

  let { detail }: { detail: HfDetail } = $props();

  const author = $derived(authorOf(detail.id));
  const repo = $derived(repoOf(detail.id));

  const chips = $derived.by(() => {
    const out = deriveBadges(detail);
    const have = new Set(out.map((c) => c.cls));
    if (detail.supportsTools && !have.has('tools')) out.push({ cls: 'tools', label: 'tools' });
    if (detail.reasoning && !have.has('reasoning')) out.push({ cls: 'reasoning', label: 'reasoning' });
    return out;
  });

  const specs = $derived.by(() => {
    const out: Array<[string, string]> = [];
    const pc = fmtParams(detail.gguf?.paramCount);
    if (pc) out.push(['params', pc]);
    const cx = fmtCtx(detail.gguf?.contextLength);
    if (cx) out.push(['context', cx]);
    if (detail.gguf?.architecture) out.push(['arch', detail.gguf.architecture]);
    if (detail.license) out.push(['license', detail.license]);
    if (detail.languages?.length) out.push(['langs', detail.languages.slice(0, 6).join(', ')]);
    if (detail.baseModel) out.push(['base', detail.baseModel]);
    return out;
  });

  const metaLine = $derived.by(() => {
    const date = detail.lastModified ? `updated ${relativeTime(detail.lastModified)}` : '';
    const qby = detail.quantizedBy ? `quantized by ${detail.quantizedBy}` : '';
    return [date, qby].filter(Boolean).join('  ·  ');
  });

  const vram = $derived(local.status?.vramTotalBytes ?? 0);
  const installed = $derived(installedFiles());
  const fitNote = $derived(
    vram && detail.fitContext
      ? `fit estimated at ${fmtCtx(detail.fitContext)} context on your ${fmtBytes(vram)} GPU`
      : 'GPU fit unknown (no NVIDIA GPU detected)',
  );

  function pull(filename: string): void {
    void startPull(`${detail.id}:${filename}`, { reasoning: detail.reasoning, supportsTools: detail.supportsTools });
  }

  // README rendered imperatively through the shared smd renderer (markdown →
  // DOM nodes; raw HTML in the card stays literal text — no injection path).
  // $state so the effect re-runs once bind:this lands (it binds after mount).
  let readmeEl = $state<HTMLDivElement>();
  $effect(() => {
    const el = readmeEl;
    if (!el) return;
    el.replaceChildren();
    const md = detail.readmeMarkdown?.trim();
    if (md) renderStatic(el, md);
  });
</script>

<div class="head">
  <div class="avatar">{(author[0] || '?').toUpperCase()}</div>
  <div class="titlewrap">
    <div class="title">
      <button class="author-link" type="button" title="Browse {author}'s models" onclick={() => void enterAuthor(author)}>{author}</button>/<span class="repo">{repo}</span>
    </div>
    <div class="stats">
      <span>↓ {fmtCount(detail.downloads)}</span>
      <span>♥ {fmtCount(detail.likes)}</span>
      {#if metaLine}<span>{metaLine}</span>{/if}
    </div>
  </div>
  <a class="hf-link" href="https://huggingface.co/{detail.id}" target="_blank" rel="noopener" title="Open on HuggingFace">HF ↗</a>
</div>

{#if chips.length}
  <div class="chips">
    {#each chips as c (c.cls + c.label)}<span class="badge {c.cls}">{c.label}</span>{/each}
  </div>
{/if}

{#if specs.length}
  <div class="spec-strip">
    {#each specs as [k, v] (k)}
      <span class="spec"><span class="spec-k">{k}</span><span class="spec-v">{v}</span></span>
    {/each}
  </div>
{/if}

<div class="section-label">Quantizations <span class="qnote">{fitNote}</span></div>
{#if detail.quants?.length}
  <div class="qtable">
    {#each detail.quants as q (q.filename)}
      <div class="q" class:is-rec={q.recommended}>
        <span class="q-name">{q.quant}{#if q.recommended}<span class="rec">best for you</span>{/if}</span>
        <span class="q-size">{fmtBytes(q.sizeBytes)}{#if (q.parts ?? 1) > 1}<span class="q-parts"> · {q.parts} parts</span>{/if}</span>
        <span class="q-fit">{#if q.fit}<span class="fit {q.fit.cls}">{q.fit.label}</span>{/if}</span>
        <span class="q-action">
          {#if installed.has(q.filename)}
            <span class="installed">✓ installed</span>
          {:else}
            <button class="pull-btn" class:rec={q.recommended} type="button" disabled={hf.pulling} onclick={() => pull(q.filename)}>Pull</button>
          {/if}
        </span>
      </div>
    {/each}
  </div>
{:else}
  <div class="placeholder">no GGUF files in this repo.</div>
{/if}

<div class="section-label">Model card</div>
{#if detail.readmeMarkdown?.trim()}
  <div class="readme" bind:this={readmeEl}></div>
{:else}
  <div class="placeholder">No model card provided.</div>
{/if}

<style>
  .head { display: flex; align-items: center; gap: 10px; }
  .avatar {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    background: var(--accent-dim);
    border: 1px solid var(--accent-edge);
    color: var(--accent);
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 16px;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
  }
  .titlewrap { min-width: 0; flex: 1; }
  .title { font-size: 15px; font-family: var(--font-display); font-weight: 600; color: var(--text-primary); word-break: break-all; }
  .author-link { background: none; border: none; padding: 0; color: var(--accent); font: inherit; cursor: pointer; }
  .author-link:hover { text-decoration: underline; }
  .stats { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11px; color: var(--text-muted); margin-top: 2px; }
  .hf-link {
    flex-shrink: 0;
    font-family: var(--font-display);
    font-size: 11px;
    letter-spacing: 1px;
    color: var(--text-muted);
    text-decoration: none;
    border: 1px solid var(--border-strong);
    padding: 4px 8px;
  }
  .hf-link:hover { color: var(--accent); border-color: var(--accent); }

  .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
  .badge {
    font-family: var(--font-display);
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 1px;
    padding: 2px 7px;
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
  }
  .badge.size { color: var(--accent); border-color: var(--accent-edge); }
  .badge.reasoning { color: var(--accent-reason); border-color: rgba(255, 184, 77, 0.3); }
  .badge.vision { color: var(--accent-purple); border-color: rgba(184, 61, 255, 0.3); }
  .badge.tools { color: var(--success); border-color: rgba(0, 255, 136, 0.25); }
  .badge.abliterated { color: var(--accent-pink); border-color: rgba(255, 45, 124, 0.3); }

  .spec-strip { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 10px; }
  .spec { display: inline-flex; gap: 6px; font-size: 11.5px; }
  .spec-k { color: var(--text-muted); font-family: var(--font-display); text-transform: uppercase; font-size: 9.5px; letter-spacing: 1px; align-self: center; }
  .spec-v { color: var(--text-secondary); font-family: var(--font-mono); }

  .section-label {
    margin-top: 14px;
    font-family: var(--font-display);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--accent);
    border-bottom: 1px solid var(--border);
    padding-bottom: 3px;
  }
  .qnote { color: var(--text-muted); letter-spacing: 0.5px; text-transform: none; margin-left: 8px; }

  .qtable { display: flex; flex-direction: column; margin-top: 6px; }
  .q {
    display: grid;
    grid-template-columns: 1.2fr 1fr 0.8fr auto;
    align-items: center;
    gap: 10px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
  }
  .q.is-rec { background: var(--accent-faint); border-left: 2px solid var(--accent); }
  .q-name { font-family: var(--font-mono); font-size: 12px; color: var(--text-primary); }
  .rec {
    margin-left: 8px;
    font-family: var(--font-display);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--accent);
  }
  .q-size { font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); }
  .q-parts { color: var(--text-muted); }
  .fit { font-family: var(--font-display); font-size: 9.5px; text-transform: uppercase; letter-spacing: 1px; }
  .fit.fits { color: var(--success); }
  .fit.tight { color: var(--warning); }
  .fit.toobig { color: var(--error); }
  .installed { font-size: 11px; color: var(--success); }
  .pull-btn {
    padding: 3px 12px;
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    font-family: var(--font-display);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .pull-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .pull-btn.rec { border-color: var(--accent); color: var(--accent); }
  .pull-btn:disabled { opacity: 0.4; cursor: default; }

  .placeholder { color: var(--text-muted); font-size: 12px; padding: 8px 0; }

  /* README is smd-rendered (unmanaged children) — style via :global. */
  .readme { margin-top: 8px; font-size: 13px; line-height: 1.55; color: var(--text-secondary); overflow-wrap: break-word; }
  .readme :global(h1), .readme :global(h2), .readme :global(h3) { color: var(--text-primary); margin: 12px 0 6px; font-size: 14px; }
  .readme :global(pre) {
    background: rgba(8, 8, 14, 0.9);
    border: 1px solid var(--border);
    padding: 8px;
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
  .readme :global(code) { font-family: var(--font-mono); font-size: 11.5px; }
  .readme :global(img) { max-width: 100%; }
  .readme :global(a) { color: var(--accent); }
  .readme :global(table) { border-collapse: collapse; }
  .readme :global(td), .readme :global(th) { border: 1px solid var(--border); padding: 3px 8px; font-size: 11.5px; }
</style>
