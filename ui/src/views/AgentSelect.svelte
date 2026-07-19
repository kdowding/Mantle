<script lang="ts">
  // Sidebar agent switcher — the active agent renders as a card (the trigger);
  // clicking it drops a roster of every agent to switch between. Composes the
  // shared Popover (block = full-width sidebar anchor, plain = let the content
  // carry the motion) + AgentCard, mirroring BackendPicker's summary→popover
  // idiom. Each roster card powers on CRT-style, staggered — the same
  // "session open" entrance the transcript bubbles use (MessageShell ent-pop).
  import type { Agent } from '../lib/api';
  import Popover from '../components/Popover.svelte';
  import AgentCard from '../components/AgentCard.svelte';

  let { agents, active, onSelect, onEdit }: {
    agents: Agent[];
    active: Agent | null;
    onSelect: (id: string) => void;
    onEdit: (id: string) => void;
  } = $props();

  let open = $state(false);
</script>

{#if active}
  {@const a = active}
  <Popover bind:open block plain align="left">
    {#snippet trigger({ toggle, open: isOpen })}
      <AgentCard agent={a} selected chevron open={isOpen} onSelect={() => toggle()} />
    {/snippet}

    <div class="as-list">
      {#each agents as agent, i (agent.id)}
        <div class="as-row" style="--eo: {i}">
          <AgentCard
            {agent}
            selected={agent.id === a.id}
            onSelect={(id) => { open = false; onSelect(id); }}
            onEdit={(id) => { open = false; onEdit(id); }}
          />
        </div>
      {/each}
    </div>
  </Popover>
{:else}
  <div class="muted">loading agents…</div>
{/if}

<style>
  .as-list { display: flex; flex-direction: column; gap: 6px; }

  /* Roster entrance — each agent powers on like a transcript bubble when a
     session opens: a bright CRT snap from a thin line, staggered by row
     (--eo). Lifted from MessageShell's ent-pop so the two reads as one
     language. The panel itself only fades (Popover plain), so this cascade is
     the whole show. */
  .as-row {
    transform-origin: 50% 0;
    animation: as-pop 0.16s calc(var(--eo, 0) * 55ms) cubic-bezier(0.22, 0.61, 0.36, 1) backwards;
  }
  @keyframes as-pop {
    0%   { opacity: 0; transform: scaleY(0.05) scaleX(0.75); filter: brightness(9) saturate(0.2); }
    45%  { opacity: 1; transform: scaleY(0.55) scaleX(1); filter: brightness(2.6); }
    100% { opacity: 1; transform: scaleY(1) scaleX(1); filter: brightness(1) saturate(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .as-row { animation: none; }
  }

  .muted { color: var(--text-muted); font-size: 13px; padding: 8px 2px; }
</style>
