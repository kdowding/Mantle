<script lang="ts">
  // Context-window gauge — a slim instrument strip above the composer:
  // current fill, the model's window, and a notch where compaction fires.
  // `usage.contextTokens` comes from the last turn's message_end (the server
  // reports prompt tokens), so a freshly-opened replay reads 0 until its
  // first live turn — the empty frame still shows the window + threshold.
  import { chat, usage, serverConfig } from '../lib/state.svelte';
  import { contextWindow } from '../lib/inference';

  // Prefer the authoritative per-turn bounds (from message_end, for the model
  // that actually ran); fall back to the static config lookup pre-turn.
  const win = $derived(usage.contextWindow ?? contextWindow());
  const threshold = $derived(usage.compactionThreshold ?? Math.floor(win * serverConfig.compactionFraction));
  const used = $derived(usage.contextTokens);
  const pct = $derived(Math.min(100, (used / win) * 100));
  const markPct = $derived(Math.min(100, (threshold / win) * 100));
  const nearing = $derived(used >= threshold * 0.85 && used < threshold);
  const past = $derived(used >= threshold);

  const fmtK = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const title = $derived(
    `Context: ${used.toLocaleString()} of ~${win.toLocaleString()} tokens` +
    ` · compaction summarizes the oldest messages past ${threshold.toLocaleString()}`,
  );
</script>

{#if chat.sessionId}
  <div class="ctx-bar" {title}>
    <div class="track">
      <div class="fill" class:nearing class:past style="width: {pct}%"></div>
      {#if markPct > 0 && markPct < 100}
        <div class="mark" style="left: {markPct}%"></div>
      {/if}
    </div>
    <span class="label">
      <span class="used" class:nearing class:past>{fmtK(used)}</span>/{fmtK(win)}
      <span class="sep">·</span> compact @ {fmtK(threshold)}
    </span>
  </div>
{/if}

<style>
  .ctx-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 24px 0;
    background: var(--bg-secondary);
    user-select: none;
  }

  .track {
    flex: 1;
    height: 4px;
    position: relative;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    overflow: visible; /* the mark's head pokes above the rail */
  }
  .fill {
    height: 100%;
    background: var(--accent);
    box-shadow: 0 0 6px var(--accent-glow);
    transition: width 0.4s ease, background 0.3s;
  }
  .fill.nearing { background: var(--warning); box-shadow: 0 0 6px rgba(255, 170, 0, 0.4); }
  .fill.past { background: var(--error); box-shadow: 0 0 6px rgba(255, 45, 124, 0.4); }

  /* Compaction notch — a tick crossing the rail. */
  .mark {
    position: absolute;
    top: -3px;
    bottom: -3px;
    width: 2px;
    background: var(--accent-reason);
    box-shadow: 0 0 5px var(--accent-reason-glow);
  }

  .label {
    flex-shrink: 0;
    font-family: var(--font-terminal);
    font-size: 9.5px;
    letter-spacing: 0.8px;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .label .used { color: var(--text-secondary); }
  .label .used.nearing { color: var(--warning); }
  .label .used.past { color: var(--error); }
  .label .sep { opacity: 0.5; margin: 0 2px; }

  @media (max-width: 768px) {
    .ctx-bar { padding: 4px 12px 0; }
  }
</style>
