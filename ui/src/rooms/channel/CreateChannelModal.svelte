<script lang="ts">
  // Create a channel: title + the agents to call in. Opens the new channel.
  import Modal from '../../components/Modal.svelte';
  import Button from '../../components/Button.svelte';
  import { ui, serverConfig, avatarSrc } from '../../lib/state.svelte';
  import { type Agent } from '../../lib/api';
  import { backendById, displayModel } from '../../lib/inference';
  import { createChannel, openChannelView } from './channel.svelte';

  let { onclose }: { onclose: () => void } = $props();

  let title = $state('');
  let picked = $state<Set<string>>(new Set());
  let error = $state('');
  let saving = $state(false);

  // Row meta line — mirrors the settings agent list (vendor · model).
  function summarize(agent: Agent): string {
    const backend = agent.defaultProvider ? backendById(agent.defaultProvider) : undefined;
    const model = agent.defaultModel || backend?.defaultModel || null;
    const vendor = backend ? serverConfig.vendorLabels[backend.vendor] || backend.vendor : 'default';
    return model ? `${vendor} · ${displayModel(model)}` : vendor;
  }

  function toggleAgent(id: string): void {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    picked = next;
  }

  async function create(): Promise<void> {
    error = '';
    if (!title.trim()) { error = 'Title is required.'; return; }
    if (picked.size === 0) { error = 'Call in at least one agent.'; return; }
    saving = true;
    try {
      const meta = await createChannel(title.trim(), [...picked]);
      onclose();
      void openChannelView(meta.id);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }
</script>

<Modal open title="Create Channel" size="sm" onclose={onclose}>
  <div class="form">
    <label class="field">
      <span>Title</span>
      <input type="text" bind:value={title} placeholder="e.g. war-room" />
    </label>
    <div class="field">
      <span>Call in{#if picked.size}<em class="count"> - {picked.size} selected</em>{/if}</span>
      <div class="agents">
        {#each ui.agents as a (a.id)}
          {@const on = picked.has(a.id)}
          <button
            type="button"
            class="agent-row"
            class:on
            style:--row-accent={a.accentColor || null}
            aria-pressed={on}
            onclick={() => toggleAgent(a.id)}
          >
            <span class="av">
              {#if a.hasAvatar}
                <img src={avatarSrc(a.id)} alt="" />
              {:else}
                {(a.name || a.id || '?').charAt(0).toUpperCase()}
              {/if}
            </span>
            <span class="info">
              <span class="nm">{a.name}</span>
              <span class="meta">{summarize(a)}</span>
            </span>
            <span class="check" aria-hidden="true"></span>
          </button>
        {/each}
      </div>
    </div>
    {#if error}<div class="error">{error}</div>{/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={onclose}>Cancel</Button>
    <Button variant="primary" onclick={() => void create()} disabled={saving}>
      {saving ? 'Creating…' : 'Create'}
    </Button>
  {/snippet}
</Modal>

<style>
  /* Form styling comes from the global form kit (src/form.css); only what's
     unique to this modal lives here — the selectable agent roster (avatar +
     identity + check), styled after the settings agent list. */
  .count { font-style: normal; letter-spacing: 0; color: var(--accent); }

  /* Bounded scroll: stretches to fit a handful of agents, then scrolls —
     never grows unbounded with a large roster. */
  .agents {
    display: flex;
    flex-direction: column;
    gap: 7px;
    max-height: 420px;
    overflow-y: auto;
    padding: 1px; /* breathing room for the selected border */
  }

  .agent-row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 9px 11px;
    text-align: left;
    background: var(--bg-panel, var(--bg-tertiary));
    border: 1px solid var(--border);
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
  }
  .agent-row:hover {
    border-color: var(--row-accent, var(--accent));
    background: color-mix(in srgb, var(--row-accent, var(--accent)) 7%, transparent);
  }
  .agent-row.on {
    border-color: var(--row-accent, var(--accent));
    background: color-mix(in srgb, var(--row-accent, var(--accent)) 10%, var(--bg-secondary));
  }

  .av {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 15px;
    color: var(--row-accent, var(--accent));
    background: var(--bg-tertiary);
    border: 1px solid var(--row-accent, var(--accent));
    clip-path: polygon(10% 0, 100% 0, 100% 90%, 90% 100%, 0 100%, 0 10%);
  }
  .av img { width: 100%; height: 100%; object-fit: cover; }

  .info { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .nm {
    font-family: var(--font-display);
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .check {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    border: 1px solid var(--border-strong);
    background: var(--bg-input);
    transition: background 0.15s, border-color 0.15s;
    clip-path: polygon(3px 0, 100% 0, 100% calc(100% - 3px), calc(100% - 3px) 100%, 0 100%, 0 3px);
  }
  .agent-row:hover .check { border-color: var(--row-accent, var(--accent)); }
  .agent-row.on .check {
    background: var(--row-accent, var(--accent));
    border-color: var(--row-accent, var(--accent));
  }
  .agent-row.on .check::after {
    content: '✓';
    color: var(--bg-primary);
    font-size: 13px;
    font-weight: 700;
    line-height: 1;
  }
</style>
