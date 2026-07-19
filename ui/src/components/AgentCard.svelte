<script lang="ts">
  import type { Agent } from '../lib/api';
  import { avatarSrc } from '../lib/state.svelte';

  let { agent, selected = false, onSelect, onEdit, chevron = false, open = false }: {
    agent: Agent;
    selected?: boolean;
    onSelect: (id: string) => void;
    onEdit?: (id: string) => void; // shows a hover ✎ when provided
    chevron?: boolean; // render a dropdown chevron (▾) in place of the select mark — for the switcher trigger
    open?: boolean; // chevron rotation (dropdown open state)
  } = $props();

  // Each card carries its OWN agent's accent (not the active theme accent),
  // so the roster reads as a row of distinct identities.
  const cardAccent = $derived(agent.accentColor || 'var(--accent)');
  let imgFailed = $state(false);
</script>

<div class="agent-card" class:selected style="--card-accent: {cardAccent}">
  <button class="agent-main" type="button" onclick={() => onSelect(agent.id)}>
    {#if agent.hasAvatar && !imgFailed}
      <img class="avatar-img" src={avatarSrc(agent.id)} alt="" onerror={() => (imgFailed = true)} />
    {:else}
      <span class="avatar">{agent.name.charAt(0).toUpperCase()}</span>
    {/if}
    <span class="name">{agent.name}</span>
    {#if chevron}
      <span class="chev" class:open aria-hidden="true">▾</span>
    {:else}
      <span class="sel-mark" aria-hidden="true">▸</span>
    {/if}
  </button>
  {#if onEdit}
    <button class="edit" type="button" title="Edit agent" aria-label="Edit {agent.name}" onclick={() => onEdit(agent.id)}>✎</button>
  {/if}
</div>

<style>
  .agent-card {
    display: flex;
    align-items: stretch;
    width: 100%;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
    clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
  }
  .agent-card:hover { border-color: color-mix(in srgb, var(--card-accent) 45%, transparent); }
  .agent-card.selected {
    border-color: var(--card-accent);
    background: color-mix(in srgb, var(--card-accent) 6%, var(--bg-secondary));
    box-shadow: inset 3px 0 12px -4px var(--card-accent);
  }

  .agent-main {
    display: flex;
    align-items: center;
    gap: 11px;
    flex: 1;
    min-width: 0;
    padding: 10px 12px;
    background: transparent;
    border: none;
    color: var(--text-primary);
    cursor: pointer;
    text-align: left;
  }

  /* Hover-revealed edit affordance — a themed notched icon button carrying
     the agent's own accent (border + glyph), with a slide-in reveal, an
     accent glow on hover, and a press dip. Keyboard focus reveals it too. */
  .edit {
    flex-shrink: 0;
    align-self: center;
    width: 32px;
    height: 32px;
    margin-right: 9px;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--card-accent) 8%, var(--bg-input));
    border: 1px solid color-mix(in srgb, var(--card-accent) 45%, var(--border-strong));
    color: var(--card-accent);
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    transform: translateX(6px) scale(0.85);
    transition: opacity 0.16s ease, transform 0.16s ease, background 0.16s, border-color 0.16s, box-shadow 0.16s, color 0.16s;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
  }
  .agent-card:hover .edit,
  .edit:focus-visible {
    opacity: 1;
    transform: translateX(0) scale(1);
  }
  .edit:hover {
    background: color-mix(in srgb, var(--card-accent) 22%, var(--bg-input));
    border-color: var(--card-accent);
    box-shadow: 0 0 12px -2px var(--card-accent);
    color: var(--text-primary);
  }
  .edit:active { transform: scale(0.9); }

  @media (prefers-reduced-motion: reduce) {
    .edit,
    .agent-card:hover .edit,
    .edit:focus-visible,
    .edit:active { transform: none; }
  }

  .avatar {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    font-size: 15px;
    background: color-mix(in srgb, var(--card-accent) 14%, var(--bg-input));
    border: 1px solid color-mix(in srgb, var(--card-accent) 55%, transparent);
    color: var(--card-accent);
    font-weight: 700;
    font-family: var(--font-display);
    flex-shrink: 0;
    clip-path: polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px);
  }
  .avatar-img {
    width: 34px;
    height: 34px;
    object-fit: cover;
    flex-shrink: 0;
    border: 1px solid color-mix(in srgb, var(--card-accent) 55%, transparent);
    clip-path: polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px);
  }

  .name {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 15px;
    letter-spacing: 0.5px;
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sel-mark {
    flex-shrink: 0;
    font-size: 10px;
    color: var(--card-accent);
    opacity: 0;
    transform: translateX(-4px);
    transition: opacity 0.15s, transform 0.15s;
  }
  .agent-card.selected .sel-mark { opacity: 1; transform: translateX(0); }

  /* Dropdown chevron — the switcher trigger's affordance (always visible,
     rotates when the roster is open). */
  .chev {
    flex-shrink: 0;
    font-size: 10px;
    color: var(--card-accent);
    transition: transform 0.18s ease;
  }
  .chev.open { transform: rotate(180deg); }
  @media (prefers-reduced-motion: reduce) {
    .chev { transition: none; }
  }
</style>
