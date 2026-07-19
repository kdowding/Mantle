<script lang="ts">
  // Backend + model picker. A summary button opens a popover with backends
  // grouped under vendor headers (Claude / ChatGPT / Grok / Local — a row per
  // access mode) and the selected backend's models as name + role-hint rows
  // (MODEL_META in lib/inference; unlisted ids fall back to the raw id).
  // Selecting a backend keeps the popover open (to pick a model); selecting a
  // model closes it. Drives `provider`/`model` on the send.
  import { serverConfig, prefs } from '../lib/state.svelte';
  import { selectedBackend, selectBackend, selectModel, backendSummary, modeLabel, modelMeta } from '../lib/inference';
  import type { Backend } from '../lib/api';
  import Popover from '../components/Popover.svelte';
  import CodexAuthRow from '../rooms/codex/CodexAuthRow.svelte'; // [room] contextual status row

  let open = $state(false);
  const summary = $derived(backendSummary());
  const models = $derived(selectedBackend()?.models ?? []);
  const defaultModel = $derived(selectedBackend()?.defaultModel ?? null);

  // Catalog order is the display order; group rows under their vendor.
  const vendorGroups = $derived.by(() => {
    const groups: Array<{ vendor: string; label: string; backends: Backend[] }> = [];
    for (const b of serverConfig.backends) {
      let g = groups.find((x) => x.vendor === b.vendor);
      if (!g) {
        g = { vendor: b.vendor, label: serverConfig.vendorLabels[b.vendor] || b.vendor, backends: [] };
        groups.push(g);
      }
      g.backends.push(b);
    }
    return groups;
  });

  function pickBackend(id: string): void {
    selectBackend(id);
  }
  function pickModel(m: string): void {
    selectModel(m);
    open = false;
  }
</script>

<Popover bind:open width={340} mobileInline>
  {#snippet trigger({ toggle, open: isOpen })}
    <button class="bp-trigger" type="button" onclick={toggle}>
      <span class="bp-summary">{summary}</span>
      <span class="bp-chev" class:open={isOpen}>▾</span>
    </button>
  {/snippet}

  <div class="bp-section">Backend</div>
  {#each vendorGroups as g (g.vendor)}
    <div class="bp-group">
      <div class="bp-vendor">{g.label}</div>
      <div class="bp-list">
        {#each g.backends as b (b.id)}
          <button
            class="bp-row"
            class:active={b.id === prefs.backendId}
            disabled={!b.configured}
            type="button"
            onclick={() => pickBackend(b.id)}
          >
            <span class="bp-rowlabel">{modeLabel(b)}</span>
            {#if !b.configured}<span class="bp-na">n/a</span>{/if}
          </button>
        {/each}
      </div>
    </div>
  {/each}

  {#if prefs.backendId === 'openai/subscription'}
    <CodexAuthRow />
  {/if}

  {#if models.length > 0}
    <div class="bp-section">Model</div>
    <div class="bp-list">
      {#each models as m (m)}
        {@const meta = modelMeta(m)}
        <button class="bp-row bp-model" class:active={m === prefs.model} type="button" onclick={() => pickModel(m)}>
          <span class="bp-mname">
            <span class="bp-rowlabel">{meta.name}</span>
            {#if m === defaultModel}<span class="bp-def">default</span>{/if}
          </span>
          {#if meta.hint}<span class="bp-hint">{meta.hint}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</Popover>

<style>
  .bp-trigger {
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 320px;
    padding: 5px 10px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    font-family: var(--font-display);
    font-size: 12px;
    letter-spacing: 0.5px;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .bp-trigger:hover { border-color: var(--accent); color: var(--accent); }
  .bp-summary { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bp-chev { color: var(--accent); font-size: 10px; transition: transform 0.15s; }
  .bp-chev.open { transform: rotate(180deg); }

  .bp-section {
    font-family: var(--font-display);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--text-muted);
    padding: 6px 6px 4px;
  }
  .bp-list { display: flex; flex-direction: column; gap: 2px; margin-bottom: 4px; }

  /* Vendor group — a hairline-anchored micro-header above that vendor's mode
     rows, indented so the hierarchy (vendor > mode) reads at a glance. */
  .bp-group { margin-bottom: 2px; }
  .bp-vendor {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-display);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 2px;
    color: var(--accent);
    opacity: 0.75;
    padding: 4px 6px 3px;
  }
  .bp-vendor::after {
    content: '';
    flex: 1;
    height: 1px;
    background: linear-gradient(to right, var(--border-strong), transparent);
  }
  .bp-group .bp-row { padding-left: 16px; }

  .bp-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 9px;
    background: transparent;
    border: 1px solid transparent;
    border-left: 2px solid transparent;
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }
  .bp-row:hover:not(:disabled) { background: var(--bg-tertiary); border-left-color: var(--border-strong); }
  .bp-row.active { background: var(--accent-faint); border-color: var(--accent-edge); border-left-color: var(--accent); color: var(--accent); }
  .bp-row:disabled { opacity: 0.4; cursor: default; }
  .bp-rowlabel { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Model rows — name line + muted role hint underneath. */
  .bp-model { flex-direction: column; align-items: stretch; gap: 1px; }
  .bp-mname { display: flex; align-items: center; gap: 8px; }
  .bp-hint { font-size: 10.5px; color: var(--text-muted); }
  .bp-row.active .bp-hint { color: var(--text-secondary); }
  .bp-def {
    font-family: var(--font-mono);
    font-size: 8px;
    text-transform: uppercase;
    letter-spacing: 1px;
    padding: 0 4px;
    border: 1px solid var(--accent-edge);
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .bp-row.active .bp-def { color: var(--accent); }

  .bp-na { font-family: var(--font-display); font-size: 9px; text-transform: uppercase; color: var(--text-muted); letter-spacing: 1px; }
</style>
