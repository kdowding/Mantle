<script lang="ts">
  // Canonical modal shell — the kit replacement for MantleUI.modal.create.
  // Caller owns visibility via bind:open; Esc + backdrop close it (backdrop
  // optional), footer is a snippet. Svelte transitions replace the old FX
  // race-token layer outright. Look ported from ui/styles-kit.css (.mui-modal):
  // the accent-gradient header underline is the signature.
  import type { Snippet } from 'svelte';
  import { fade, type TransitionConfig } from 'svelte/transition';

  let {
    open = $bindable(false),
    title = '',
    size = 'md',
    tall = false,
    flush = false,
    closeOnBackdrop = true,
    onclose,
    onbeforeclose,
    children,
    footer,
    actions,
  }: {
    open?: boolean;
    title?: string;
    size?: 'sm' | 'md' | 'lg' | 'xl';
    tall?: boolean; // fixed 88vh height (doc/text viewers, big browsers)
    flush?: boolean; // no body padding (embedded content fills edge-to-edge)
    closeOnBackdrop?: boolean;
    onclose?: () => void;
    onbeforeclose?: () => boolean; // sync veto: return false to keep the modal open
    children: Snippet;
    footer?: Snippet;
    actions?: Snippet; // extra header controls, left of the × button
  } = $props();

  const reduced =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // CRT power-on/off — the panel expands from a bright horizontal scan line
  // (and collapses back into one on close), like a terminal waking up. The
  // brightness flash rides the same transition; the CSS drop-shadow returns
  // once the inline filter clears.
  function crt(_node: Element, { duration = 240 }: { duration?: number } = {}): TransitionConfig {
    if (reduced) return { duration: 0 };
    return {
      duration,
      css: (t: number, u: number) => {
        const line = Math.min(1, t / 0.45); // first 45%: the line snaps open
        const sy = 0.012 + (t < 0.45 ? 0 : ((t - 0.45) / 0.55)) * 0.988;
        const sx = 0.4 + line * 0.6;
        return `transform: scaleY(${sy.toFixed(3)}) scaleX(${sx.toFixed(3)}); opacity: ${Math.min(1, t * 4).toFixed(2)}; filter: brightness(${(1 + u * 1.6).toFixed(2)}) drop-shadow(0 10px 28px rgba(0,0,0,0.55));`;
      },
    };
  }

  function close(): void {
    if (!open) return;
    if (onbeforeclose && !onbeforeclose()) return;
    open = false;
    onclose?.();
  }

  function onKey(e: KeyboardEvent): void {
    if (open && e.key === 'Escape') close();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <!-- |global: rooms mount the whole <Modal> inside their own {#if}, so the
       inner block is true at first render — a LOCAL transition would only
       play for always-mounted callers (found live: settings animated, the
       local/HF/voice modals didn't). -->
  <div
    class="overlay"
    role="dialog"
    aria-modal="true"
    aria-label={title || 'Dialog'}
    transition:fade|global={{ duration: reduced ? 0 : 150 }}
  >
    {#if closeOnBackdrop}
      <button class="backdrop" type="button" aria-label="Close" onclick={close}></button>
    {/if}
    <div class="modal {size}" class:reduced class:tall class:flush transition:crt|global>
      <header class="modal-header">
        <h2 class="modal-title">{title}</h2>
        <div class="modal-actions">
          {#if actions}{@render actions()}{/if}
          <button class="modal-close" type="button" aria-label="Close" onclick={close}>×</button>
        </div>
      </header>
      <div class="modal-body">{@render children()}</div>
      {#if footer}
        <footer class="modal-footer">{@render footer()}</footer>
      {/if}
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(10, 10, 15, 0.9);
  }

  .backdrop {
    position: absolute;
    inset: 0;
    background: transparent;
    border: none;
    cursor: default;
  }

  .modal {
    position: relative; /* above the backdrop button */
    display: flex;
    flex-direction: column;
    width: var(--modal-w, 780px);
    max-width: 90vw;
    max-height: 80vh;
    background: var(--bg-secondary);
    border: 1px solid var(--border-strong);
    /* Notched hero corners — top-right + bottom-left cut. drop-shadow (not
       box-shadow) so the glow follows the clipped shape instead of being
       clipped away with it. CAUTION: filter makes this a containing block
       for fixed-position descendants — a Popover (fixed backdrop) mounted
       inside a Modal would trap its backdrop to the modal box. None exist
       today; if one appears, swap its backdrop strategy first. */
    clip-path: polygon(0 0, calc(100% - var(--cut-lg)) 0, 100% var(--cut-lg), 100% 100%, var(--cut-lg) 100%, 0 calc(100% - var(--cut-lg)));
    filter: drop-shadow(0 10px 28px rgba(0, 0, 0, 0.55));
  }
  /* Bracket ticks on the un-notched corners. */
  .modal::before,
  .modal::after {
    content: '';
    position: absolute;
    width: 14px;
    height: 14px;
    pointer-events: none;
    z-index: 1;
  }
  .modal::before { top: 0; left: 0; border-top: 2px solid var(--accent); border-left: 2px solid var(--accent); }
  .modal::after { right: 0; bottom: 0; border-right: 2px solid var(--accent); border-bottom: 2px solid var(--accent); }
  .sm { --modal-w: 630px; }
  .md { --modal-w: 780px; }
  .lg { --modal-w: 1080px; }
  .xl { --modal-w: 1380px; }
  .tall { height: 88vh; max-height: 88vh; }
  .flush .modal-body { padding: 0; }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    position: relative;
    flex-shrink: 0;
  }
  .modal-header::after {
    content: '';
    position: absolute;
    bottom: -1px;
    left: 0;
    right: 0;
    height: 1px;
    background: linear-gradient(to right, transparent, var(--accent-glow) 30%, var(--accent) 50%, var(--accent-glow) 70%, transparent);
  }
  .modal-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 2px;
    color: var(--text-primary);
  }
  .modal-title::before { content: '// '; color: var(--accent); font-weight: 700; }
  .modal-actions { display: flex; align-items: center; gap: 8px; }
  .modal-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: transparent;
    border: 1px solid var(--error);
    color: var(--error);
    font-size: 16px;
    cursor: pointer;
    transition: background 0.2s;
  }
  .modal-close:hover { background: rgba(255, 45, 124, 0.15); }

  .modal-body {
    flex: 1;
    padding: 16px 20px;
    overflow-y: auto;
    min-height: 0;
  }

  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    padding: 14px 20px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  /* iOS-friendly: dvh + top anchor so the soft keyboard / address bar can't
     push the footer off-screen (ported behavior from the old modal CSS). */
  @media (max-width: 768px) {
    .overlay { align-items: flex-start; padding: 12px 8px; }
    .modal { max-width: 100%; width: 100%; max-height: calc(100dvh - 24px); }
    .modal-footer { padding-bottom: calc(14px + env(safe-area-inset-bottom)); }
  }
</style>
