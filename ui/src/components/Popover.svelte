<script lang="ts">
  // Anchored popover — the kit extraction of the backend-picker's
  // trigger/backdrop/panel pattern. The old UI grew 4+ hand-rolled dropdown
  // variants (backend picker, persona, agent selector, @-mention, voice);
  // every new one composes this instead. The trigger snippet receives
  // { toggle, open } and renders its own button; the panel is `children`.
  import { untrack, type Snippet } from 'svelte';
  import type { TransitionConfig } from 'svelte/transition';
  import { overlays } from '../lib/overlays.svelte';

  const reduced =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // HUD panel deploy/retract — the panel unfolds from its anchored edge (scaleY
  // toward its transform-origin, set per-direction in CSS) with a brief
  // brightness lock, and retracts the same way on close. Replaces the old
  // open-only `panel-snap` keyframe so dropdowns no longer vanish dead on close.
  function pop(_node: Element, { up = false, plain = false }: { up?: boolean; plain?: boolean } = {}): TransitionConfig {
    void up; // origin handled in CSS (.up); kept for call-site symmetry/clarity
    if (reduced) return { duration: 0 };
    // plain — opacity only, no scaleY unfold: for dropdowns whose CONTENT owns
    // the entrance motion (the agent switcher's card cascade), where the
    // panel's own transform would compound with the items'.
    if (plain) return { duration: 130, css: (t: number) => `opacity: ${Math.min(1, t * 1.6).toFixed(2)};` };
    return {
      duration: 150,
      css: (t: number, u: number) =>
        `opacity: ${Math.min(1, t * 1.7).toFixed(2)}; transform: scaleY(${(0.55 + t * 0.45).toFixed(3)}); filter: brightness(${(1 + u * 0.45).toFixed(2)});`,
    };
  }

  let {
    open = $bindable(false),
    align = 'right',
    up = false,
    width = 300,
    fixed = false,
    mobileInline = false,
    block = false,
    plain = false,
    trigger,
    children,
  }: {
    open?: boolean;
    align?: 'left' | 'right';
    up?: boolean; // open above the trigger (composer popovers)
    width?: number;
    // Position the panel viewport-fixed off the trigger's rect instead of
    // CSS-anchored — REQUIRED inside a scroll container (overflow would clip
    // an absolute panel at the scroller's bounds; found live in the channel
    // sidebar's roster).
    fixed?: boolean;
    // ≤768px: render the panel in-flow (full width) instead of floating —
    // for popovers living inside the profile bar's mobile dropdown, where a
    // floating 300px panel would overflow the viewport edge (found live on
    // the backend picker).
    mobileInline?: boolean;
    // Full-width anchor + panel — for a sidebar/full-width trigger (the agent
    // switcher) where the default inline-flex anchor would shrink to content.
    block?: boolean;
    // Opacity-only panel reveal (skip the scaleY unfold) — let the panel's
    // content carry the entrance motion instead.
    plain?: boolean;
    trigger: Snippet<[{ toggle: () => void; open: boolean }]>;
    children: Snippet;
  } = $props();

  let anchorEl = $state<HTMLDivElement | null>(null);
  let panelEl = $state<HTMLDivElement | null>(null);

  function toggle(): void {
    open = !open;
  }
  function onKey(e: KeyboardEvent): void {
    if (open && e.key === 'Escape') open = false;
  }

  // Register as an open overlay while shown, so a surface-level Escape handler
  // (the systems deck) closes THIS dropdown first instead of the page behind it.
  // untrack the mutation — `count++` reads+writes the counter, which would make
  // this effect depend on its own write and loop (effect_update_depth_exceeded).
  $effect(() => {
    if (!open) return;
    untrack(() => { overlays.popoverCount++; });
    return () => { untrack(() => { overlays.popoverCount--; }); };
  });

  // Viewport guard — a floating panel anchored near a screen edge gets nudged
  // back inside (8px margin) instead of clipping off-screen. Runs on open.
  // margin (not transform) — the entry animation owns transform.
  // Fixed mode positions off the trigger's rect first ($effect flushes before
  // paint, so the panel never flashes at its pre-positioned spot).
  $effect(() => {
    const el = panelEl;
    if (!el) return;
    if (fixed && anchorEl) {
      const a = anchorEl.getBoundingClientRect();
      const p = el.getBoundingClientRect();
      el.style.left = `${align === 'left' ? a.left : a.right - p.width}px`;
      el.style.top = up ? `${a.top - p.height - 6}px` : `${a.bottom + 6}px`;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0) return; // mobile-inline (static) — skip
    let dx = 0;
    if (r.left < 8) dx = 8 - r.left;
    else if (r.right > window.innerWidth - 8) dx = window.innerWidth - 8 - r.right;
    if (dx !== 0) el.style.marginLeft = `${dx}px`;
  });
</script>

<svelte:window onkeydown={onKey} />

<div class="anchor" class:mobile-inline={mobileInline} class:block bind:this={anchorEl}>
  {@render trigger({ toggle, open })}
  {#if open}
    <button class="backdrop" type="button" aria-label="Close" onclick={() => (open = false)}></button>
    <div class="panel" class:left={align === 'left'} class:up class:fixed bind:this={panelEl} style="width: {width}px" transition:pop={{ up, plain }}>
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .anchor { position: relative; display: inline-flex; }
  /* Full-width anchor — the panel spans the trigger (sidebar agent switcher). */
  .anchor.block { display: flex; width: 100%; }
  .anchor.block .panel { width: 100% !important; }

  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: transparent;
    border: none;
    cursor: default;
  }

  .panel {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 51;
    max-height: 60vh;
    overflow-y: auto;
    padding: 8px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-strong);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(0, 0, 0, 0.4);
    clip-path: polygon(0 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%);
    transform-origin: top right;
    /* open/close motion is the Svelte transition:pop (both directions) */
  }
  .panel.left { right: auto; left: 0; transform-origin: top left; }
  .panel.up { top: auto; bottom: calc(100% + 6px); transform-origin: bottom left; }
  /* fixed mode — coordinates land inline from the position effect */
  .panel.fixed { position: fixed; top: auto; right: auto; bottom: auto; left: auto; }

  @media (max-width: 768px) {
    .anchor.mobile-inline { display: flex; flex-direction: column; width: 100%; }
    .anchor.mobile-inline .panel {
      position: static;
      width: 100% !important;
      max-height: 300px;
      margin-top: 6px;
      clip-path: none;
      box-shadow: none;
    }
  }
</style>
