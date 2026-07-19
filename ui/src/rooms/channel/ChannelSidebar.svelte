<!-- The channel mode's own sidebar — second column beside the main one
     (Discord's channel list, mantle grammar). Channels + create on top; the
     ACTIVE channel's management below: roster (live-mic / per-agent backend /
     dismiss / call-in), conduct (volley + style + memory pack), rename, delete.
     The stage header stays read-only — every channel control lives here.
     ≤768px it becomes an off-canvas drawer driven by channel.mgmtOpen. -->
<script lang="ts">
  import { ui, getFeature } from '../../lib/state.svelte';
  import { formatTimeAgo } from '../../lib/format';
  import Popover from '../../components/Popover.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import {
    channel, selectChannel, deleteChannel, patchParticipants, patchVolley,
    patchChannelMeta, VOLLEY_CAP_UI,
  } from './channel.svelte';
  import RosterRow from './RosterRow.svelte';
  import CreateChannelModal from './CreateChannelModal.svelte';

  let creating = $state(false);
  let callInOpen = $state(false);

  const meta = $derived(channel.meta);
  const availableAgents = $derived(
    ui.agents.filter((a) => !(meta?.participants ?? []).includes(a.id)),
  );

  // Memory pack gate — the per-channel toggle is moot when Englyph isn't ready.
  const memFeature = $derived(getFeature('memory'));
  const memDisabled = $derived(!!memFeature && !memFeature.ready);

  // Rename — resync only when the stored title actually changes (channel
  // switch / save landed), so meta refreshes from other patches never clobber
  // an edit in progress.
  let renameDraft = $state('');
  let lastTitle = '';
  $effect(() => {
    const t = channel.meta?.title ?? '';
    if (t !== lastTitle) {
      lastTitle = t;
      renameDraft = t;
    }
  });
  function applyRename(): void {
    const title = renameDraft.trim();
    if (!title || title === channel.meta?.title) return;
    void patchChannelMeta({ title });
  }

  function callIn(agentId: string): void {
    callInOpen = false;
    void patchParticipants({ add: [agentId] });
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && channel.mgmtOpen) channel.mgmtOpen = false;
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="chan-backdrop" class:active={channel.mgmtOpen} onclick={() => (channel.mgmtOpen = false)}></div>
<aside class="chan-side" class:mobile-open={channel.mgmtOpen}>
  <div class="side-sect">
    <span class="side-sect-label">⌗ channels</span>
    <button class="side-sect-btn" type="button" title="Create channel" aria-label="Create channel" onclick={() => (creating = true)}>+</button>
  </div>

  <div class="chan-list">
    {#each channel.channels as c (c.id)}
      <button class="chan-item" class:active={c.id === channel.activeId} type="button" onclick={() => void selectChannel(c.id)}>
        <span class="ci-name"><span class="ci-hash">#</span>{c.title}</span>
        <span class="ci-meta">{c.participants.length} agent{c.participants.length === 1 ? '' : 's'}{c.lastMessageAt ? ` · ${formatTimeAgo(c.lastMessageAt)}` : ''}</span>
      </button>
    {/each}
    {#if channel.channels.length === 0}
      <div class="chan-empty">No channels yet. Click + to start a hangout.</div>
    {/if}
  </div>

  {#if meta}
    <div class="mgmt">
      <div class="side-sect">
        <span class="side-sect-label">// roster</span>
        {#if availableAgents.length > 0}
          <Popover bind:open={callInOpen} align="left" width={200} fixed>
            {#snippet trigger({ toggle })}
              <button class="side-sect-btn" type="button" title="Call in an agent" aria-label="Call in an agent" onclick={toggle}>+</button>
            {/snippet}
            {#each availableAgents as a (a.id)}
              <button class="ci-row" type="button" onclick={() => callIn(a.id)}>{a.name}</button>
            {/each}
          </Popover>
        {/if}
      </div>
      <div class="roster">
        {#each meta.participants as pid (pid)}
          <RosterRow {pid} />
        {/each}
        {#if meta.participants.length === 0}
          <div class="chan-empty">Empty room - call someone in.</div>
        {/if}
      </div>

      <div class="side-sect">
        <span class="side-sect-label">// conduct</span>
      </div>
      <div class="conduct">
        <label class="c-row">
          <span title="Agents hand the floor to each other until the turn budget runs out - 'jump in' takes it back.">Volley</span>
          <Toggle checked={meta.volley?.enabled ?? false} label="Volley enabled" onchange={(v) => void patchVolley({ enabled: v })} />
        </label>
        <div class="c-row" class:dim={!meta.volley?.enabled}>
          <span>Max turns</span>
          <div class="stepper">
            <button type="button" aria-label="Fewer turns" onclick={() => void patchVolley({ maxTurns: Math.max(1, (meta?.volley?.maxTurns ?? 3) - 1) })}>−</button>
            <span>{meta.volley?.maxTurns ?? 3}</span>
            <button type="button" aria-label="More turns" onclick={() => void patchVolley({ maxTurns: Math.min(VOLLEY_CAP_UI, (meta?.volley?.maxTurns ?? 3) + 1) })}>+</button>
          </div>
        </div>
        <div class="c-row" class:dim={!meta.volley?.enabled}>
          <span>Style</span>
          <div class="seg">
            <button
              type="button"
              class:on={(meta.volley?.style ?? 'free') === 'free'}
              title="The floor follows @-mentions - whoever the last reply mentions speaks next"
              onclick={() => void patchVolley({ style: 'free' })}
            >free</button>
            <button
              type="button"
              class:on={meta.volley?.style === 'round-robin'}
              title="Rotate through the live mics in order - @-mentions don't steer"
              onclick={() => void patchVolley({ style: 'round-robin' })}
            >robin</button>
          </div>
        </div>
        <label class="c-row">
          <span title={memDisabled ? (memFeature?.setupHint ?? memFeature?.detail ?? 'Memory is unavailable') : 'Each speaker recalls from their own memory store before replying - adds a beat of latency per turn.'}>Memory pack</span>
          <Toggle checked={(meta.memoryPack ?? false) && !memDisabled} label="Memory pack" disabled={memDisabled} onchange={(v) => void patchChannelMeta({ memoryPack: v })} />
        </label>
      </div>

      <div class="side-sect">
        <span class="side-sect-label">// channel</span>
      </div>
      <div class="meta-ops">
        <div class="rename-row">
          <input
            class="rename-input"
            bind:value={renameDraft}
            placeholder="Channel name"
            maxlength="120"
            onkeydown={(e) => { if (e.key === 'Enter') applyRename(); }}
          />
          <button
            class="rename-save"
            type="button"
            disabled={!renameDraft.trim() || renameDraft.trim() === meta.title}
            onclick={applyRename}
          >save</button>
        </div>
        <button class="del-btn" type="button" onclick={() => void deleteChannel(meta)}>✕ delete channel</button>
      </div>
    </div>
  {/if}
</aside>

{#if creating}
  <CreateChannelModal onclose={() => (creating = false)} />
{/if}

<style>
  .chan-side {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px 12px;
    min-height: 0;
    overflow-y: auto;
    background: var(--bg-secondary);
    border-right: 1px solid var(--border-strong);
    position: relative;
    animation: chan-in 0.18s ease-out;
  }
  /* Same neon seam as the main sidebar's right edge — reads as one family. */
  .chan-side::after {
    content: '';
    position: absolute;
    top: 0;
    right: -1px;
    bottom: 0;
    width: 1px;
    background: linear-gradient(to bottom, var(--accent) 0%, transparent 18%, transparent 82%, var(--accent-edge) 100%);
    pointer-events: none;
  }
  @keyframes chan-in {
    from { opacity: 0; transform: translateX(-10px); }
  }
  @media (prefers-reduced-motion: reduce) {
    .chan-side { animation: none; }
  }

  /* ── Channel list ──────────────────────────────────────────────────────── */
  .chan-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex-shrink: 0;
    max-height: 34vh;
    overflow-y: auto;
  }
  .chan-item {
    padding: 9px 11px;
    background: transparent;
    border: 1px solid transparent;
    border-left: 2px solid transparent;
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }
  .chan-item:hover { background: var(--bg-tertiary); border-left-color: var(--border-strong); }
  .chan-item.active { background: var(--accent-faint); border-color: var(--accent-edge); border-left-color: var(--accent); }
  .ci-name {
    display: block;
    font-size: 14.5px;
    font-family: var(--font-display);
    font-weight: 600;
    letter-spacing: 0.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ci-hash { color: var(--accent); margin-right: 1px; }
  .ci-meta { display: block; font-size: 11px; color: var(--text-muted); margin-top: 2px; }
  .chan-empty { color: var(--text-muted); font-size: 13px; padding: 6px 2px; line-height: 1.5; }

  /* ── Active-channel management ─────────────────────────────────────────── */
  .mgmt { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
  .roster { display: flex; flex-direction: column; gap: 4px; }
  .ci-row {
    display: block;
    width: 100%;
    padding: 8px 10px;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    color: var(--text-primary);
    font-size: 14px;
    text-align: left;
    cursor: pointer;
  }
  .ci-row:hover { background: var(--accent-faint); border-left-color: var(--accent); }

  .conduct { display: flex; flex-direction: column; gap: 11px; padding: 0 2px; }
  .c-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 13.5px;
    color: var(--text-secondary);
    transition: opacity 0.15s;
  }
  .c-row.dim { opacity: 0.45; }
  .stepper { display: flex; align-items: center; gap: 8px; }
  .stepper button {
    width: 25px;
    height: 25px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    color: var(--text-primary);
    font-size: 14px;
    cursor: pointer;
  }
  .stepper button:hover { border-color: var(--accent-edge); color: var(--accent); }
  .stepper span { font-family: var(--font-mono); font-size: 14px; min-width: 20px; text-align: center; }

  /* free / round-robin segmented pair */
  .seg { display: flex; }
  .seg button {
    padding: 5px 10px;
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 11px;
    letter-spacing: 1px;
    text-transform: uppercase;
    cursor: pointer;
    transition: color 0.12s, background 0.12s, border-color 0.12s;
  }
  .seg button + button { border-left: none; }
  .seg button:hover { color: var(--text-secondary); }
  .seg button.on { color: var(--accent); border-color: var(--accent-edge); background: var(--accent-dim); }

  .meta-ops { display: flex; flex-direction: column; gap: 8px; padding: 0 2px; }
  .rename-row { display: flex; gap: 6px; }
  .rename-input {
    flex: 1;
    min-width: 0;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    color: var(--text-primary);
    font-size: 13.5px;
    padding: 7px 9px;
  }
  .rename-input:focus { outline: none; border-color: var(--accent); }
  .rename-save {
    padding: 0 12px;
    background: transparent;
    border: 1px solid var(--accent-edge);
    color: var(--accent);
    font-family: var(--font-display);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    cursor: pointer;
  }
  .rename-save:disabled { opacity: 0.4; cursor: default; }
  .rename-save:hover:not(:disabled) { background: var(--accent-faint); }

  .del-btn {
    align-self: flex-start;
    padding: 6px 11px;
    background: transparent;
    border: 1px dashed color-mix(in srgb, var(--error) 45%, transparent);
    color: color-mix(in srgb, var(--error) 75%, var(--text-muted));
    font-family: var(--font-display);
    font-size: 11px;
    letter-spacing: 1px;
    text-transform: uppercase;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }
  .del-btn:hover { color: var(--error); border-color: var(--error); background: rgba(255, 45, 124, 0.07); }

  /* ── Mobile (≤768px) — off-canvas drawer, same pattern as the main one ─── */
  .chan-backdrop { display: none; }

  @media (max-width: 768px) {
    .chan-side {
      position: fixed;
      top: 0;
      left: 0;
      bottom: 0;
      width: min(300px, 86vw);
      z-index: 52;
      transform: translateX(-100%);
      transition: transform 0.3s ease;
      animation: none;
      padding-bottom: calc(16px + env(safe-area-inset-bottom));
      box-shadow: 8px 0 32px rgba(0, 0, 0, 0.5);
    }
    .chan-side.mobile-open { transform: translateX(0); }

    .chan-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(10, 10, 15, 0.7);
      z-index: 51;
    }
    .chan-backdrop:not(.active) { display: none; }
    .chan-backdrop.active { display: block; }
  }

  @media (prefers-reduced-motion: reduce) {
    .chan-side { transition: none; }
  }
</style>
