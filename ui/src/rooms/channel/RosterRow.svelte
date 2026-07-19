<script lang="ts">
  // One roster row in the channel sidebar: avatar · name (+ override tag) ·
  // live-mic toggle · model picker · dismiss. The picker mirrors the 1:1
  // profile-bar cascade against the live backend catalog and PATCHes the
  // channel's sticky per-agent override: backend click keeps the popover open
  // (pick a model next), model
  // click closes, "Agent default" clears. The override is channel-scoped —
  // 1:1 sessions are untouched.
  import { serverConfig, avatarSrc } from '../../lib/state.svelte';
  import { displayModel } from '../../lib/inference';
  import Popover from '../../components/Popover.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { channel, agentById, patchAutoRespond, patchParticipants, patchModelOverride } from './channel.svelte';

  let { pid }: { pid: string } = $props();

  let open = $state(false);
  let pickedProvider = $state<string | null>(null);
  let imgFailed = $state(false);

  const agent = $derived(agentById(pid));
  const accent = $derived(agent?.accentColor ?? 'var(--accent)');
  const isLive = $derived((channel.meta?.autoRespond ?? []).includes(pid));
  const override = $derived(channel.meta?.modelOverrides?.[pid]);
  const providerBackends = $derived(serverConfig.backends.filter((b) => b.configured));
  const models = $derived(
    pickedProvider ? serverConfig.backends.find((b) => b.id === pickedProvider)?.models ?? [] : [],
  );
  // Compact "what's overridden" tag under the name: model wins, else the backend.
  const overrideTag = $derived(
    override
      ? (override.model
          ? displayModel(override.model)
          : serverConfig.backends.find((b) => b.id === override.provider)?.label ?? override.provider ?? '')
      : '',
  );

  // Re-anchor the cascade on the stored override each time the popover opens.
  $effect(() => {
    if (open) pickedProvider = override?.provider ?? null;
  });

  function pickBackend(id: string): void {
    pickedProvider = id;
    void patchModelOverride(pid, id, undefined); // backend-only = its default model
  }
  function pickModel(m: string): void {
    const provider = pickedProvider ?? override?.provider;
    if (!provider) return;
    void patchModelOverride(pid, provider, m);
    open = false;
  }
  function clearOverride(): void {
    pickedProvider = null;
    void patchModelOverride(pid, undefined, undefined);
    open = false;
  }
</script>

<div class="r-row" style:--m-accent={accent}>
  {#if agent?.hasAvatar && !imgFailed}
    <img class="r-avatar" src={avatarSrc(pid)} alt="" onerror={() => (imgFailed = true)} />
  {:else}
    <span class="r-avatar r-initial">{(agent?.name ?? pid).charAt(0).toUpperCase()}</span>
  {/if}
  <div class="r-id">
    <span class="r-name">{agent?.name ?? pid}</span>
    <span class="r-sub" class:has-ov={!!overrideTag} title={overrideTag ? 'Backend override in this channel' : ''}>
      {overrideTag || (isLive ? 'live mic' : 'mention-only')}
    </span>
  </div>
  <Toggle
    checked={isLive}
    label="Auto-respond (live mic) - speaks without an @-mention"
    onchange={(v) => void patchAutoRespond(pid, v)}
  />
  <Popover bind:open width={250} fixed align="left">
    {#snippet trigger({ toggle })}
      <button
        class="r-cfg"
        class:has-ov={!!override}
        type="button"
        title="Backend for {agent?.name ?? pid} in this channel"
        onclick={toggle}
      >▾</button>
    {/snippet}
    <div class="mo-section">backend · this channel</div>
    <button class="mo-row" class:active={!override} type="button" onclick={clearOverride}>
      Agent default
    </button>
    {#each providerBackends as b (b.id)}
      <button class="mo-row" class:active={pickedProvider === b.id} type="button" onclick={() => pickBackend(b.id)}>
        {b.label}
      </button>
    {/each}
    {#if models.length > 0}
      <div class="mo-section">model</div>
      <div class="mo-models">
        {#each models as m (m)}
          <button class="mo-row" class:active={override?.model === m} type="button" onclick={() => pickModel(m)}>
            {m}
          </button>
        {/each}
      </div>
    {/if}
  </Popover>
  <button class="r-x" type="button" title="Dismiss from channel" onclick={() => void patchParticipants({ remove: [pid] })}>×</button>
</div>

<style>
  .r-row {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 8px 9px;
    border: 1px solid transparent;
    border-left: 2px solid color-mix(in srgb, var(--m-accent) 55%, transparent);
    background: color-mix(in srgb, var(--m-accent) 4%, transparent);
    transition: background 0.12s, border-color 0.12s;
  }
  .r-row:hover {
    background: color-mix(in srgb, var(--m-accent) 8%, transparent);
    border-color: color-mix(in srgb, var(--m-accent) 25%, transparent);
    border-left-color: var(--m-accent);
  }

  .r-avatar {
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    object-fit: cover;
    display: grid;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--m-accent) 45%, transparent);
    clip-path: polygon(5px 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%, 0 5px);
  }
  .r-initial {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 14px;
    color: var(--m-accent);
    background: color-mix(in srgb, var(--m-accent) 12%, transparent);
  }

  .r-id { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .r-name {
    font-family: var(--font-display);
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--m-accent);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .r-sub {
    font-family: var(--font-mono);
    font-size: 9.5px;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .r-sub.has-ov { color: var(--text-secondary); }

  .r-cfg {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
    padding: 4px 3px;
    transition: color 0.15s;
  }
  .r-cfg:hover, .r-cfg.has-ov { color: var(--m-accent); }
  .r-x { background: none; border: none; color: var(--text-muted); font-size: 15px; cursor: pointer; padding: 2px 3px; }
  .r-x:hover { color: var(--error); }

  .mo-section {
    font-family: var(--font-display);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--text-muted);
    padding: 5px 8px 3px;
  }
  .mo-models { max-height: 220px; overflow-y: auto; }
  .mo-row {
    display: block;
    width: 100%;
    padding: 6px 9px;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    color: var(--text-primary);
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: background 0.12s, border-color 0.12s;
  }
  .mo-row:hover { background: var(--bg-tertiary); border-left-color: var(--border-strong); }
  .mo-row.active { color: var(--accent); border-left-color: var(--accent); background: var(--accent-faint); }
</style>
