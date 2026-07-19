<script lang="ts">
  // Assembled system-prompt preview: the three zones (stable / persona /
  // dynamic) with token estimates, reflecting current toggles + skills +
  // memory-pack setting (pack content is a placeholder — it's per-message).
  import { workspace, loadPreview } from './workspace.svelte';

  let openZones = $state<Set<string>>(new Set(['stable']));

  const p = $derived(workspace.preview);
  const zones = $derived(
    p
      ? [
          { id: 'stable', label: 'Stable (cached)', text: p.stable, tokens: p.meta.tokens.stable },
          { id: 'persona', label: 'Persona (cached per-mask)', text: p.persona, tokens: p.meta.tokens.persona },
          { id: 'dynamic', label: 'Dynamic (never cached)', text: p.dynamic, tokens: p.meta.tokens.dynamic },
        ].filter((z) => z.text)
      : [],
  );

  function toggleZone(id: string): void {
    const next = new Set(openZones);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    openZones = next;
  }
</script>

{#if workspace.previewError}
  <div class="error">Failed to build preview: {workspace.previewError}</div>
{:else if !p}
  <div class="muted">Assembling system prompt…</div>
{:else}
  <div class="meta">
    <span class="chip">~{p.meta.tokens.total.toLocaleString()} tokens</span>
    {#if p.meta.persona}<span class="chip">persona: {p.meta.persona}</span>{/if}
    <span class="chip">memory pack: {p.meta.memoryPackEnabled ? 'on' : 'off'}</span>
    {#if p.meta.tokens.standingSkills > 0}<span class="chip">standing skills: ~{p.meta.tokens.standingSkills}</span>{/if}
    {#if p.meta.tokens.skillsCatalog > 0}<span class="chip">skills catalog: ~{p.meta.tokens.skillsCatalog}</span>{/if}
    <button class="refresh" type="button" onclick={() => void loadPreview(true)}>↻ refresh</button>
  </div>

  {#each zones as z (z.id)}
    <div class="zone">
      <button class="z-header" type="button" onclick={() => toggleZone(z.id)}>
        <span class="chev" class:open={openZones.has(z.id)}>▸</span>
        <span class="z-label">{z.label}</span>
        <span class="z-tokens">~{z.tokens.toLocaleString()} tok</span>
      </button>
      {#if openZones.has(z.id)}
        <pre class="z-body">{z.text}</pre>
      {/if}
    </div>
  {/each}
{/if}

<style>
  .muted { color: var(--text-muted); font-size: 13px; }
  .error { color: var(--error); font-size: 12px; }

  .meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
  .chip {
    padding: 3px 8px;
    border: 1px solid var(--border-strong);
    font-family: var(--font-display);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-secondary);
  }
  .refresh {
    margin-left: auto;
    padding: 3px 10px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .refresh:hover { border-color: var(--accent); color: var(--accent); }

  .zone { border: 1px solid var(--border); border-left: 2px solid var(--accent); background: var(--bg-tertiary); margin-bottom: 6px; }
  .z-header {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 9px 12px;
    background: transparent;
    border: none;
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
  }
  .chev { font-size: 9px; color: var(--accent); transition: transform 0.15s; }
  .chev.open { transform: rotate(90deg); }
  .z-label { flex: 1; font-family: var(--font-display); font-size: 12px; letter-spacing: 1px; text-transform: uppercase; }
  .z-tokens { font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); }

  .z-body {
    margin: 0;
    padding: 4px 12px 12px 31px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.55;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-wrap: break-word;
    max-height: 420px;
    overflow-y: auto;
  }
</style>
