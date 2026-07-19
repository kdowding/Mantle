<script lang="ts">
  // Toast stack — bottom-right, above everything but modals. Click opens the
  // delivery's session; × dismisses. Mounted once from App (bolt-on).
  import { activity, dismissToast, openToast, registerActivityWs } from './activity.svelte';

  registerActivityWs(); // idempotent
</script>

{#if activity.toasts.length > 0}
  <div class="toast-stack">
    {#each activity.toasts as t (t.id)}
      <div class="toast">
        <button class="toast-body" type="button" onclick={() => void openToast(t)}>{t.text}</button>
        <button class="toast-x" type="button" aria-label="Dismiss" onclick={() => dismissToast(t.id)}>×</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-stack {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 80; /* above chat chrome, below modal overlays (90) */
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: min(380px, calc(100vw - 32px));
  }

  .toast {
    display: flex;
    align-items: stretch;
    background: var(--bg-secondary);
    border: 1px solid var(--accent-edge);
    border-left: 2px solid var(--accent);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55), 0 0 14px var(--accent-dim);
    clip-path: polygon(0 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%);
    animation: toast-in 0.22s ease-out;
  }
  @keyframes toast-in {
    from { opacity: 0; transform: translateX(14px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .toast { animation: none; }
  }

  .toast-body {
    flex: 1;
    min-width: 0;
    padding: 10px 12px;
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-family: var(--font-display);
    font-size: 12px;
    letter-spacing: 0.5px;
    text-align: left;
    cursor: pointer;
  }
  .toast-body:hover { color: var(--accent); }

  .toast-x {
    flex-shrink: 0;
    width: 28px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 14px;
    cursor: pointer;
  }
  .toast-x:hover { color: var(--error); }
</style>
