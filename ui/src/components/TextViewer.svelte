<script lang="ts">
  // Format-aware text viewer. Render modes by extension (first = default):
  //   .md/.markdown → Source / Rendered (markdown via the smd one-shot)
  //   .csv/.tsv     → Table (sticky header, zebra) / Source
  //   .json         → Formatted (pretty + highlighted) / Source
  //   anything else → Source only (no toggle shown)
  // The header button shows the NEXT mode's label — it's a toggle, not status.
  import Modal from './Modal.svelte';
  import StreamingText from './StreamingText.svelte';
  import { overlay } from '../lib/state.svelte';
  import { extOf, parseCsv, prettyJson, highlightJson } from '../lib/viewers';

  type Mode = 'source' | 'rendered' | 'table' | 'formatted';
  const LABEL: Record<Mode, string> = {
    source: 'Source',
    rendered: 'Rendered',
    table: 'Table',
    formatted: 'Formatted',
  };

  const ext = $derived(overlay.text ? extOf(overlay.text.name) : '');
  const modes = $derived.by<Mode[]>(() => {
    if (ext === 'md' || ext === 'markdown') return ['source', 'rendered'];
    if (ext === 'csv' || ext === 'tsv') return ['table', 'source'];
    if (ext === 'json') return ['formatted', 'source'];
    return ['source'];
  });

  let modeIdx = $state(0);
  $effect(() => {
    void overlay.text; // a new file resets to its default mode
    modeIdx = 0;
  });
  const mode = $derived(modes[modeIdx] ?? 'source');
  const nextLabel = $derived(LABEL[modes[(modeIdx + 1) % modes.length]]);

  const rows = $derived(
    mode === 'table' && overlay.text
      ? parseCsv(overlay.text.content, ext === 'tsv' ? '\t' : ',')
      : [],
  );
  const json = $derived(
    mode === 'formatted' && overlay.text ? prettyJson(overlay.text.content) : null,
  );
</script>

{#if overlay.text}
  {@const t = overlay.text}
  <Modal open title={t.name} size="xl" tall onclose={() => (overlay.text = null)}>
    {#snippet actions()}
      {#if modes.length > 1}
        <button class="mode-btn" type="button" onclick={() => (modeIdx = (modeIdx + 1) % modes.length)}>
          {nextLabel}
        </button>
      {/if}
    {/snippet}

    {#if mode === 'rendered'}
      {#key t.content}
        <div class="markdown"><StreamingText text={t.content} /></div>
      {/key}
    {:else if mode === 'table'}
      {#if rows.length === 0}
        <pre class="src">{t.content}</pre>
      {:else}
        <div class="table-wrap">
          <table>
            <thead>
              <tr>{#each rows[0] as cell, i (i)}<th>{cell}</th>{/each}</tr>
            </thead>
            <tbody>
              {#each rows.slice(1) as row, ri (ri)}
                <tr>{#each row as cell, ci (ci)}<td>{cell}</td>{/each}</tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {:else if mode === 'formatted' && json}
      {#if json.valid}
        <pre class="src json">{@html highlightJson(json.pretty)}</pre>
      {:else}
        <div class="hint">Invalid JSON - showing raw text</div>
        <pre class="src">{t.content}</pre>
      {/if}
    {:else}
      <pre class="src">{t.content}</pre>
    {/if}
  </Modal>
{/if}

<style>
  .mode-btn {
    padding: 4px 12px;
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    font-family: var(--font-display);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .mode-btn:hover { border-color: var(--accent); color: var(--accent); }

  .src {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-wrap: break-word;
    color: var(--text-primary);
  }

  /* Highlighter spans arrive via {@html} — no Svelte scope hash. */
  .json :global(.json-key) { color: var(--accent); }
  .json :global(.json-string) { color: #ffb84d; }
  .json :global(.json-keyword) { color: var(--accent-purple, #b83dff); }
  .json :global(.json-number) { color: var(--error, #ff2d7c); }

  .hint {
    margin-bottom: 8px;
    font-family: var(--font-display);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--error);
  }

  .table-wrap { overflow: auto; max-height: 100%; }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 12.5px;
  }
  th {
    position: sticky;
    top: 0;
    background: var(--bg-tertiary);
    font-family: var(--font-display);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--accent);
    text-align: left;
  }
  th, td { padding: 6px 10px; border: 1px solid var(--border); }
  tbody tr:nth-child(even) { background: rgba(255, 255, 255, 0.02); }
</style>
