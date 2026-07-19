<script lang="ts">
  // Segmented capacity meter (context budget / VRAM prediction). Room-local —
  // segments are colored by position from a fixed palette; the legend mirrors.
  export interface MeterSegment {
    label: string;
    value: number;
    pretty: string; // formatted value for the legend ("~4.2K" / "~9.1 GB")
  }

  let { segments, total, summary, level = 'ok', hint = '' }: {
    segments: MeterSegment[];
    total: number; // bar denominator (context window / VRAM total)
    summary: string;
    level?: 'ok' | 'tight' | 'over';
    hint?: string;
  } = $props();

  const PALETTE = ['#5b6abf', '#00d4aa', '#ffb84d', '#b83dff', '#8c93b6', '#ff2d7c'];
  const denom = $derived(total > 0 ? total : Math.max(1, segments.reduce((a, s) => a + s.value, 0)));
</script>

<div class="meter">
  <div class="bar">
    {#each segments as s, i (s.label)}
      <span class="seg" style="width: {Math.min(100, (s.value / denom) * 100).toFixed(1)}%; background: {PALETTE[i % PALETTE.length]}"></span>
    {/each}
  </div>
  <div class="summary {level}">{summary}</div>
  <div class="legend">
    {#each segments as s, i (s.label)}
      <span class="leg"><span class="dot" style="background: {PALETTE[i % PALETTE.length]}"></span>{s.label} {s.pretty}</span>
    {/each}
  </div>
  {#if hint}<div class="hint">{hint}</div>{/if}
</div>

<style>
  .meter { display: flex; flex-direction: column; gap: 5px; }

  .bar {
    display: flex;
    height: 8px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    overflow: hidden;
  }
  .seg { height: 100%; opacity: 0.85; }

  .summary { font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); }
  .summary.tight { color: var(--warning); }
  .summary.over { color: var(--error); }

  .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; }
  .leg { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--text-muted); }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }

  .hint { font-size: 10px; color: var(--text-muted); }
</style>
