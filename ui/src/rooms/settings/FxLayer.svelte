<!-- Chat-effects mount layer — a stable, pointer-transparent host that sits
     behind the stage's content (App gives stage children z-index: 1). The
     canvas engine owns everything inside; this component just gives it a
     place to live and reacts to the settings toggle. -->
<script lang="ts">
  import { settings } from './settings.svelte';
  import { enableFx, disableFx } from './chat-effects';

  let host: HTMLDivElement;

  $effect(() => {
    if (!settings.fx) return;
    enableFx(host);
    return () => disableFx();
  });
</script>

<div class="fx-layer" bind:this={host} aria-hidden="true"></div>

<style>
  .fx-layer {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    overflow: hidden;
  }
  .fx-layer :global(canvas) {
    position: absolute;
    inset: 0;
    display: block;
  }
</style>
