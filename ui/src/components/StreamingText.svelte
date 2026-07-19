<script lang="ts">
  // The streaming island. Svelte renders the .msg-content shell and owns its
  // class/cursor reactively, but its CHILDREN are written imperatively by
  // lib/stream.ts — Svelte must not manage them. Increment 2b swaps the
  // module's plain-text writer for smd + the reveal clock.
  import { onMount } from 'svelte';
  import { attach, renderStatic, type Island } from '../lib/stream';

  // Live run: attach to the reveal island — a part-owned one when provided
  // (voice room's audio-paced reveal, session-entrance typewriters), else the
  // chat singleton. Replay: `text` is set → render once via the same smd
  // renderer (no island, no cursor). `ghost` (entrance) stacks a HIDDEN
  // full render under the island in the same grid cell, so the bubble owns
  // its final height before a single character types — layout never shifts.
  let { streaming = false, text, island, ghost, entrance = false }: {
    streaming?: boolean;
    text?: string;
    island?: Island;
    ghost?: string;
    // FIRST mount of a session entrance → animate the island. Any later mount
    // (the systems/channel stage swap remounts Chat) renders `text` statically.
    entrance?: boolean;
  } = $props();
  // bind:this only — read once in onMount, never drive re-renders.
  let node = $state<HTMLDivElement>(null as unknown as HTMLDivElement);
  let ghostNode = $state<HTMLDivElement | undefined>(undefined);

  onMount(() => {
    if (ghostNode && ghost != null) renderStatic(ghostNode, ghost);
    // Entrance first showing → animate the reveal island (the island owns the
    // live node here, even though `text` is kept). Every later mount falls
    // through to the static render of the durable text, so a spent island can
    // never leave the bubble blank.
    if (entrance && island) island.attach(node);
    else if (text != null) renderStatic(node, text);
    else if (island) island.attach(node);
    else attach(node);
  });
</script>

<!-- No children expression on the island/ghost nodes: Svelte leaves their
     content to the imperative writers. .md-body (global) styles both. -->
{#if ghost != null && island}
  <div class="msg-content size-stack">
    <div class="md-body ghost" bind:this={ghostNode} aria-hidden="true"></div>
    <div class="md-body live-layer" class:streaming-cursor={streaming} bind:this={node}></div>
  </div>
{:else}
  <div class="msg-content md-body" class:streaming-cursor={streaming} bind:this={node}></div>
{/if}

<style>
  .msg-content {
    font-family: var(--font-sans);
    word-wrap: break-word;
  }

  /* Entrance sizing stack — ghost + island share one grid cell; the hidden
     ghost defines the final box, the island types into the claimed space. */
  .size-stack { display: grid; }
  .size-stack > :global(*) { grid-area: 1 / 1; min-width: 0; }
  .ghost { visibility: hidden; }

  /* Transmission cursor while the run is live — a glowing accent line whose halo
     throbs (a live signal, not a hard on/off blink). Matches the assist dock. */
  .streaming-cursor::after {
    content: '';
    display: inline-block;
    width: 3px;
    height: 1.05em;
    background: var(--accent);
    box-shadow: 0 0 6px var(--accent-glow);
    margin-left: 3px;
    vertical-align: text-bottom;
    animation: stream-cursor 1.1s ease-in-out infinite;
  }
  @keyframes stream-cursor {
    0%, 100% { opacity: 1; box-shadow: 0 0 8px var(--accent-glow), 0 0 3px var(--accent); }
    50%      { opacity: 0.45; box-shadow: 0 0 2px var(--accent-glow); }
  }
  @media (prefers-reduced-motion: reduce) {
    .streaming-cursor::after { animation: none; }
  }
</style>
