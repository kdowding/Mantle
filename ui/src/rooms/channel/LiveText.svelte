<script lang="ts">
  // Island-bound live content node — Svelte renders the shell, the channel's
  // per-bubble stream island writes the children (never managed by Svelte).
  import { onMount } from 'svelte';
  import type { Island } from '../../lib/stream';

  let { island }: { island: Island | null } = $props();
  let node: HTMLDivElement;

  onMount(() => {
    island?.attach(node);
  });
</script>

<!-- .md-body (global, app.css) styles the island-written markdown. -->
<div class="live md-body" bind:this={node}></div>

<style>
  .live { font-family: var(--font-sans); word-wrap: break-word; }
</style>
