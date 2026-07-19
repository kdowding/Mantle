<script lang="ts">
  // Tools tab of the systems deck — the agent's REAL tool surface, managed.
  // Each agent-visible tool (and each whole group) can be toggled off; disable
  // is a hard capability gate enforced for chat AND heartbeat/cron/channel/
  // subagent (front door, applyToolSurface). The englyph_* + remember +
  // recall_source tools that are registered-but-internal live in their own
  // collapsed section so the page stops misreporting the memory surface.
  import { ui } from '../../lib/state.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { tools, loadTools, toggleTools, groupTools, type ToolGroup } from './tools.svelte';

  $effect(() => {
    void loadTools(ui.currentAgentId);
  });

  const agentName = $derived(ui.agents.find((a) => a.id === ui.currentAgentId)?.name ?? '');

  const agentVisible = $derived(tools.list.filter((t) => t.visibility === 'agent'));
  const internalTools = $derived(tools.list.filter((t) => t.visibility === 'internal'));

  const visibleGroups = $derived(groupTools(agentVisible));
  const internalGroups = $derived(groupTools(internalTools));

  // The honest per-request cost: only tools the agent actually sees AND that
  // aren't disabled. (The raw-registry total this page used to show was the lie.)
  const advertised = $derived(agentVisible.filter((t) => !t.disabled));
  const advertisedTokens = $derived(advertised.reduce((s, t) => s + t.estTokens, 0));
  const disabledCount = $derived(agentVisible.length - advertised.length);

  let internalOpen = $state(false);

  // A group is "off" when every member is disabled; the header toggle flips the
  // whole group. Mixed (some off) still reads as on — clicking it disables all.
  function groupOff(g: ToolGroup): boolean {
    return g.items.length > 0 && g.items.every((t) => t.disabled);
  }
  function groupActive(g: ToolGroup): number {
    return g.items.filter((t) => !t.disabled).length;
  }
  function toggleGroup(g: ToolGroup, on: boolean): void {
    const id = ui.currentAgentId;
    if (!id) return;
    void toggleTools(id, g.items.map((t) => t.name), !on);
  }
  function toggleOne(name: string, on: boolean): void {
    const id = ui.currentAgentId;
    if (!id) return;
    void toggleTools(id, [name], !on);
  }
</script>

<div class="tools-deck">
  <div class="td-sum">
    <span class="td-sum-strong">{advertised.length}</span> tools advertised to {agentName} ·
    ~{(advertisedTokens / 1000).toFixed(1)}k tokens per request{#if disabledCount} ·
      <span class="td-sum-off">{disabledCount} disabled</span>{/if}{#if internalTools.length} ·
      {internalTools.length} internal{/if}
  </div>

  <div class="td-scroll">
    {#each visibleGroups as g (g.label)}
      <div class="td-group">
        <span class="tdg-name">{g.label}</span>
        <span class="tdg-meta">{groupActive(g)}/{g.items.length} on · {g.tokens} tok</span>
        <span class="tdg-toggle" title="Toggle the whole {g.label} group">
          <Toggle checked={!groupOff(g)} label="Toggle {g.label}" onchange={(on) => toggleGroup(g, on)} />
        </span>
      </div>
      {#each g.items as t (t.name)}
        <div class="td-row" class:off={t.disabled}>
          <span class="td-sw"><Toggle checked={!t.disabled} label="Enable {t.name}" onchange={(on) => toggleOne(t.name, on)} /></span>
          <span class="td-name">{t.name}</span>
          <span class="td-tok">{t.estTokens} tok</span>
          <span class="td-desc">{t.description}</span>
        </div>
      {/each}
    {/each}

    {#if internalTools.length > 0}
      <button class="td-internal-head" type="button" onclick={() => (internalOpen = !internalOpen)}>
        <span class="arrow" class:open={internalOpen}>▸</span>
        internal · not agent-visible
        <span class="tdi-count">{internalTools.length}</span>
      </button>
      {#if internalOpen}
        <div class="td-internal-note">
          Registered but hidden from {agentName}'s chat surface - the pre-inference memory pack and the
          heartbeat archivist call these directly. The agent's memory surface is the curated
          <code>recall</code> / <code>recall_history</code> / <code>recall_area</code> /
          <code>expand_memory</code> / <code>memory_status</code> wrappers above.
        </div>
        {#each internalGroups as g (g.label)}
          <div class="td-group dim">
            <span class="tdg-name">{g.label}</span>
            <span class="tdg-meta">{g.items.length} internal · {g.tokens} tok</span>
          </div>
          {#each g.items as t (t.name)}
            <div class="td-row internal">
              <span class="td-sw"><span class="td-lock" title="System-internal - not toggleable">⛒</span></span>
              <span class="td-name">{t.name}</span>
              <span class="td-tok">{t.estTokens} tok</span>
              <span class="td-desc">{t.description}</span>
            </div>
          {/each}
        {/each}
      {/if}
    {/if}

    {#if tools.error}
      <div class="td-empty error">{tools.error}</div>
    {:else if tools.list.length === 0}
      <div class="td-empty">{tools.loading ? 'Loading…' : 'No tools registered.'}</div>
    {/if}
  </div>
</div>

<style>
  .tools-deck { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 12px; }

  .td-sum {
    flex-shrink: 0;
    font-family: var(--font-terminal);
    font-size: 11.5px;
    letter-spacing: 0.5px;
    color: var(--text-muted);
    line-height: 1.6;
  }
  .td-sum-strong { color: var(--accent); font-weight: 700; }
  .td-sum-off { color: var(--warning); }

  .td-scroll { flex: 1; min-height: 0; overflow-y: auto; padding-right: 6px; }

  .td-group {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 16px 2px 6px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
  }
  .td-group:first-child { padding-top: 0; }
  .td-group.dim { opacity: 0.7; }
  .tdg-name {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 13px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--accent);
  }
  .td-group.dim .tdg-name { color: var(--text-muted); }
  .tdg-meta { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted); }
  .tdg-toggle { margin-left: auto; align-self: center; }

  .td-row {
    display: grid;
    grid-template-columns: 30px 240px 64px 1fr;
    gap: 14px;
    align-items: baseline;
    padding: 7px 10px;
    border-left: 2px solid transparent;
    transition: background 0.12s, border-color 0.12s, opacity 0.12s;
  }
  .td-row:hover { background: var(--bg-tertiary); border-left-color: var(--border-strong); }
  .td-row.off { opacity: 0.5; }
  .td-row.off .td-name { text-decoration: line-through; color: var(--text-muted); }
  .td-row.internal { opacity: 0.78; }
  .td-sw { align-self: center; display: flex; }
  .td-lock { color: var(--text-muted); font-size: 12px; opacity: 0.7; }
  .td-name {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .td-tok { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted); text-align: right; }
  .td-desc {
    font-size: 12.5px;
    color: var(--text-secondary);
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* ── Internal section ──────────────────────────────────────────────────── */
  .td-internal-head {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    margin-top: 22px;
    padding: 10px 2px;
    background: transparent;
    border: none;
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 2px;
    text-transform: uppercase;
    cursor: pointer;
    transition: color 0.15s;
  }
  .td-internal-head:hover { color: var(--text-secondary); }
  .td-internal-head .arrow { transition: transform 0.15s; display: inline-block; }
  .td-internal-head .arrow.open { transform: rotate(90deg); }
  .tdi-count {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-muted);
    border: 1px solid var(--border-strong);
    padding: 0 5px;
  }
  .td-internal-note {
    font-size: 11.5px;
    color: var(--text-muted);
    line-height: 1.6;
    padding: 2px 4px 10px;
    max-width: 760px;
  }
  .td-internal-note code {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    padding: 0 3px;
  }

  .td-empty { color: var(--text-muted); font-size: 13px; padding: 10px 2px; }
  .td-empty.error { color: var(--error); }

  @media (max-width: 1100px) {
    .td-row { grid-template-columns: 30px 190px 56px 1fr; gap: 10px; }
  }
</style>
