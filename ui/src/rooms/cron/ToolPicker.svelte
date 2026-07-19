<script lang="ts">
  // Per-job tool picker — choose exactly which tools a scheduled run may use,
  // beyond the coarse preset. The model: `value` is the job's payload.toolsAllow
  // — [] means "follow the preset" (stays live as the registry grows; this is
  // the tested `toolsAllow:[]` → preset fallback), a non-empty list is an
  // explicit, fixed surface. The preset chips are quick-fill; tweaking any tool
  // switches to a custom list seeded from the preset's current tools.
  import Modal from '../../components/Modal.svelte';
  import { fetchToolCatalog, groupTools, type ToolInfo } from '../../lib/toolCatalog';

  let {
    open = $bindable(false),
    agentId,
    preset,
    value,
    onsave,
  }: {
    open?: boolean;
    agentId: string | null;
    preset: 'mechanical' | 'aware' | 'companion';
    value: string[]; // [] = follow preset · [names] = explicit custom surface
    onsave: (toolsAllow: string[]) => void;
  } = $props();

  let catalog = $state<ToolInfo[] | null>(null);
  let cronSafe = $state<string[]>([]);
  let loadErr = $state<string | null>(null);
  let loadedFor = $state<string | null>(null);

  // Pickable = what a run could actually be granted: agent-visible tools only
  // (internal englyph_* plumbing is never user-selectable). cron_report /
  // cron_snooze are pinned pseudo-tools (always injected), not registry tools,
  // so they don't appear here.
  const pickable = $derived((catalog ?? []).filter((t) => t.visibility === 'agent'));
  const groups = $derived(groupTools(pickable));

  // The preset's default tool set as concrete, grantable names over the LIVE
  // registry: companion = the whole pickable surface; mechanical/aware = the
  // safe-set. Disabled (per-agent gate) tools are dropped — they can't be run.
  const presetNames = $derived.by(() => {
    const base = preset === 'companion' ? pickable.map((t) => t.name) : cronSafe;
    return new Set(base.filter((n) => pickable.some((t) => t.name === n && !t.disabled)));
  });

  // 'preset' mirrors presetNames (a live, read-only preview); 'custom' is the
  // user's editable set. Seeded each time the modal opens.
  let mode = $state<'preset' | 'custom'>('preset');
  let custom = $state<Set<string>>(new Set());

  const selected = $derived(mode === 'preset' ? presetNames : custom);
  const totalTokens = $derived(
    pickable.filter((t) => selected.has(t.name)).reduce((s, t) => s + t.estTokens, 0),
  );

  // Seed on the open transition only — never on edits (which would clobber the
  // user's toggles). prevOpen is plain (not reactive) so writing it can't loop.
  let prevOpen = false;
  $effect(() => {
    const isOpen = open;
    if (isOpen && !prevOpen) {
      mode = value.length > 0 ? 'custom' : 'preset';
      custom = new Set(value);
      if (agentId && loadedFor !== agentId) {
        loadedFor = agentId;
        catalog = null;
        loadErr = null;
        void fetchToolCatalog(agentId)
          .then((c) => { catalog = c.tools; cronSafe = c.cronSafeTools; })
          .catch((e) => { loadErr = e instanceof Error ? e.message : String(e); });
      }
    }
    prevOpen = isOpen;
  });

  function toggle(name: string): void {
    // First edit from a preset preview materializes it as the starting custom
    // set, then applies the toggle.
    const next = mode === 'preset' ? new Set(presetNames) : new Set(custom);
    if (next.has(name)) next.delete(name); else next.add(name);
    mode = 'custom';
    custom = next;
  }

  function resetToPreset(): void {
    mode = 'preset';
    custom = new Set();
  }

  function save(): void {
    // 'preset' → [] (follow the preset, stays live); 'custom' → the explicit list.
    onsave(mode === 'preset' ? [] : [...custom]);
    open = false;
  }
</script>

<Modal bind:open title="Cron tools" size="md" tall>
  <div class="tp">
    <div class="tp-head">
      <span class="tp-mode" class:custom={mode === 'custom'}>
        {mode === 'preset'
          ? `following ${preset} preset · ${presetNames.size}`
          : `custom · ${custom.size} tool${custom.size === 1 ? '' : 's'}`}
      </span>
      <span class="tp-tok">~{totalTokens} tok</span>
      {#if mode === 'custom'}
        <button class="tp-reset" type="button" onclick={resetToPreset}>↺ follow preset</button>
      {/if}
    </div>
    <p class="tp-hint">
      Exactly which tools this job's runs may use. Following the preset stays live — new tools join automatically;
      a custom set is fixed to what you check. <code>cron_report</code> / <code>cron_snooze</code> are always available.
    </p>

    {#if loadErr}
      <div class="tp-empty err">{loadErr}</div>
    {:else if catalog === null}
      <div class="tp-empty">Loading…</div>
    {:else if groups.length === 0}
      <div class="tp-empty">No selectable tools for this agent.</div>
    {:else}
      {#each groups as g (g.label)}
        <div class="tp-group">
          <span class="tp-gname">{g.label}</span>
          <span class="tp-gmeta">{g.items.length}</span>
        </div>
        {#each g.items as t (t.name)}
          <label class="tp-row" class:off={t.disabled} class:on={selected.has(t.name)} title={t.description}>
            <input
              type="checkbox"
              checked={selected.has(t.name)}
              disabled={t.disabled}
              onchange={() => toggle(t.name)}
            />
            <span class="tp-name">{t.name}</span>
            {#if t.disabled}<span class="tp-flag">disabled for agent</span>{/if}
            <span class="tp-rtok">{t.estTokens}</span>
          </label>
        {/each}
      {/each}
    {/if}
  </div>

  {#snippet footer()}
    <button class="tp-cancel" type="button" onclick={() => (open = false)}>cancel</button>
    <button class="tp-apply" type="button" onclick={save}>apply</button>
  {/snippet}
</Modal>

<style>
  .tp { display: flex; flex-direction: column; gap: 4px; }

  .tp-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    position: sticky;
    top: 0;
    background: var(--bg-secondary);
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
    z-index: 1;
  }
  .tp-mode {
    font-family: var(--font-display);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .tp-mode.custom { color: var(--accent); }
  .tp-tok { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); }
  .tp-reset {
    margin-left: auto;
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 10.5px;
    padding: 2px 9px;
    cursor: pointer;
  }
  .tp-reset:hover { color: var(--accent); border-color: var(--accent-edge); }

  .tp-hint { font-size: 12px; color: var(--text-muted); line-height: 1.5; margin: 8px 0 4px; }
  .tp-hint code { font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); }

  .tp-group {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 9px 2px 3px;
    font-family: var(--font-terminal);
    font-size: 10px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--accent);
    opacity: 0.85;
  }
  .tp-gmeta { font-size: 9.5px; color: var(--text-muted); }

  .tp-row {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 6px 8px;
    border-left: 2px solid transparent;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }
  .tp-row:hover { background: var(--bg-tertiary); border-left-color: var(--border-strong); }
  .tp-row.on { border-left-color: var(--accent); }
  .tp-row.off { opacity: 0.5; cursor: not-allowed; }
  .tp-row input { accent-color: var(--accent); cursor: inherit; }
  .tp-name {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tp-row.off .tp-name { text-decoration: line-through; color: var(--text-muted); }
  .tp-flag {
    font-family: var(--font-mono);
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--warning);
  }
  .tp-rtok { margin-left: auto; font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); }

  .tp-empty { color: var(--text-muted); font-size: 13px; padding: 16px 2px; }
  .tp-empty.err { color: var(--error); }

  .tp-cancel,
  .tp-apply {
    padding: 6px 16px;
    font-family: var(--font-display);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    cursor: pointer;
    background: transparent;
  }
  .tp-cancel { border: 1px solid var(--border-strong); color: var(--text-muted); }
  .tp-cancel:hover { color: var(--text-secondary); }
  .tp-apply { border: 1px solid var(--accent-edge); color: var(--accent); }
  .tp-apply:hover { background: var(--accent-faint); border-color: var(--accent); }
</style>
