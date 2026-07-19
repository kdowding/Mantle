<script lang="ts">
  // Fullscreen image lightbox. Click anywhere or press Esc to close.
  import { overlay } from '../lib/state.svelte';

  function close(): void {
    overlay.lightboxUrl = null;
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if overlay.lightboxUrl}
  <button class="lightbox" type="button" aria-label="Close image" onclick={close}>
    <img src={overlay.lightboxUrl} alt="" />
  </button>
{/if}

<style>
  .lightbox {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4vh 4vw;
    background: rgba(2, 2, 6, 0.9);
    border: none;
    cursor: zoom-out;
  }
  .lightbox img {
    max-width: 92vw;
    max-height: 92vh;
    object-fit: contain;
    border: 1px solid var(--border-strong);
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
  }
</style>
