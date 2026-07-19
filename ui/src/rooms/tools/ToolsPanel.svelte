<script lang="ts">
  // Sidebar tools panel (systems group) — the glance tier over the current
  // agent's REAL (advertised) tool surface, grouped by capability/origin with
  // per-tool + total token weight. Disabled tools dim; internal (englyph_*)
  // tools live only in the deck. Management (toggles, group control) is the
  // full-page deck — open it with the ⤢ button.
  import { ui } from '../../lib/state.svelte';
  import { tools, loadTools, groupTools } from './tools.svelte';
  import { accordionSlide } from '../../lib/crt';

  const agentVisible = $derived(tools.list.filter((t) => t.visibility === 'agent'));
  const groups = $derived(groupTools(agentVisible));
  const advertised = $derived(agentVisible.filter((t) => !t.disabled));
  const totalTokens = $derived(advertised.reduce((s, t) => s + t.estTokens, 0));

  // Lazy: fetch on first expand, not at boot — but re-fetch on agent switch.
  $effect(() => {
    if (tools.open) void loadTools(ui.currentAgentId);
  });
</script>

<div class="tools-panel">
  <div class="side-sect">
    <button class="side-toggle" type="button" onclick={() => (tools.open = !tools.open)}>
      <span class="arrow" class:open={tools.open}>▸</span>
      <span class="label">// tools</span>
      {#if advertised.length}
        <span class="count">{advertised.length} · ~{(totalTokens / 1000).toFixed(1)}k tok</span>
      {/if}
    </button>
    <button class="side-sect-btn" type="button" title="Open in systems deck" aria-label="Manage tools" onclick={() => (ui.deckTab = 'tools')}>⤢</button>
  </div>

  {#if tools.open}
    <div class="t-list" transition:accordionSlide>
      {#each groups as g (g.label)}
        <div class="t-group">
          <span class="t-gname">{g.label}</span>
          <span class="t-gmeta">{g.items.length} · {g.tokens} tok</span>
        </div>
        {#each g.items as t (t.name)}
          <div class="t-item" class:off={t.disabled} title={t.disabled ? `${t.name} - disabled for this agent` : t.description}>
            <span class="t-name">{t.name}</span>
            <span class="t-tok">{t.estTokens}</span>
          </div>
        {/each}
      {/each}
      {#if tools.error}
        <div class="empty error">{tools.error}</div>
      {:else if groups.length === 0}
        <div class="empty">{tools.loading ? 'Loading…' : 'No tools registered.'}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tools-panel { flex-shrink: 0; display: flex; flex-direction: column; min-height: 0; }

  .t-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 6px;
    max-height: 34vh;
    overflow-y: auto;
  }

  .t-group {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    padding: 7px 2px 2px;
    font-family: var(--font-terminal);
    font-size: 10px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--accent);
    opacity: 0.85;
  }
  .t-group:first-child { padding-top: 0; }
  .t-gmeta { font-size: 9.5px; color: var(--text-muted); letter-spacing: 0.5px; }

  .t-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 10px;
    border-left: 2px solid transparent;
    transition: background 0.12s, border-color 0.12s;
  }
  .t-item:hover { background: var(--bg-tertiary); border-left-color: var(--border-strong); }
  .t-item.off { opacity: 0.45; }
  .t-item.off .t-name { text-decoration: line-through; color: var(--text-muted); }
  .t-name {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .t-tok {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-muted);
  }

  .empty { color: var(--text-muted); font-size: 13px; padding: 6px 2px; }
  .empty.error { color: var(--error); }
</style>
