<script lang="ts">
  // PDF / browser-renderable document viewer. <object> rather than a sandboxed
  // iframe — Edge refuses sandbox→PDF-extension navigation ("This page has
  // been blocked" on localhost); the browser's embedded PDF viewer is already
  // sandboxed itself. Fallback content shows when inline render isn't possible.
  // Unmounting the modal removes the <object>, so the PDF parser stops.
  import Modal from './Modal.svelte';
  import { overlay } from '../lib/state.svelte';
</script>

{#if overlay.doc}
  {@const d = overlay.doc}
  <Modal open title={d.name} size="xl" tall flush onclose={() => (overlay.doc = null)}>
    {#snippet actions()}
      <a class="hdr-link" href={d.url} target="_blank" rel="noopener" title="Open in new tab" aria-label="Open in new tab">↗</a>
      <a class="hdr-link" href={d.url} download={d.name} title="Download" aria-label="Download">⭳</a>
    {/snippet}
    <object class="frame" type="application/pdf" data={d.url} title={d.name}>
      <div class="fallback">
        <div class="fallback-msg">PDF preview unavailable in this browser.</div>
        <a href={d.url} target="_blank" rel="noopener">Open in new tab</a>
      </div>
    </object>
  </Modal>
{/if}

<style>
  .hdr-link {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    text-decoration: none;
    font-size: 14px;
    transition: border-color 0.15s, color 0.15s;
  }
  .hdr-link:hover { border-color: var(--accent); color: var(--accent); }

  .frame { display: block; width: 100%; height: 100%; }

  .fallback {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 48px 24px;
    color: var(--text-muted);
    font-size: 14px;
  }
  .fallback a { color: var(--accent); }
</style>
