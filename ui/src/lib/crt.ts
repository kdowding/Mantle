// CRT signal transitions, as Svelte transitions. A view "loses signal"
// (collapses to a bright scan line)
// and the next one "acquires" (expands from the line with a brightness bloom
// that settles). Pair them on swapped views: out:crtLoss + in:crtAcquire with
// the acquire delayed past the loss so they read as one sequence.
import { slide, type SlideParams, type TransitionConfig } from 'svelte/transition';

const reduced = (): boolean =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// Accordion expand/collapse — Svelte's height-slide, but reduced-motion-gated
// (the built-in slide ignores the media query) and tuned snappier than its 400ms
// default. The sidebar's // systems group + its skill/tool/cron/heartbeat panel
// bodies all ride this so they ease open and closed instead of snapping.
export function accordionSlide(node: Element, params: SlideParams = {}): TransitionConfig {
  if (reduced()) return { duration: 0 };
  return slide(node, { duration: 200, ...params });
}

export function crtLoss(_node: Element, { duration = 100 }: { duration?: number } = {}): TransitionConfig {
  if (reduced()) return { duration: 0 };
  return {
    duration,
    // out: t runs 1 → 0. Collapse to a 0.6%-height line while blowing out
    // bright and desaturating — the phosphor dying.
    css: (t: number, u: number) => {
      const sy = Math.max(0.006, t * t);
      return `transform: scaleY(${sy.toFixed(4)}); filter: brightness(${(1 + u * 10).toFixed(2)}) saturate(${t.toFixed(2)}); opacity: ${Math.max(0.25, t).toFixed(2)};`;
    },
  };
}

export function crtAcquire(
  _node: Element,
  // Defaults tuned with crtLoss's: acquire starts as the loss line dies (~10ms
  // overlap) and the whole swap settles in ~310ms — snappy but still reads.
  { duration = 220, delay = 90 }: { duration?: number; delay?: number } = {},
): TransitionConfig {
  if (reduced()) return { duration: 0 };
  return {
    delay,
    duration,
    // in: t runs 0 → 1. Hold the line briefly, expand with a soft bloom +
    // blur that resolves — signal locking back in.
    css: (t: number, u: number) => {
      const sy = 0.006 + t * t * 0.994;
      return `transform: scaleY(${sy.toFixed(4)}); filter: brightness(${(1 + u * 8).toFixed(2)}) saturate(${(0.2 + t * 0.8).toFixed(2)}) blur(${(u * 1.6).toFixed(2)}px);`;
    },
  };
}

// ── Lateral re-tune — the HORIZONTAL cousin of crtLoss/crtAcquire ───────────
// Page-level view swaps lose signal vertically (collapse to a scan line). But
// switching TABS inside an already-open deck is a smaller move — the signal
// re-tunes sideways: the outgoing pane slips out and dims while the incoming
// one slides in from the travel direction with a brightness lock. Keeping the
// axis distinct (horizontal vs the page's vertical) reads as "same page, new
// channel" rather than "new page". `dir` is +1 toward a later tab, -1 toward an
// earlier one, so the slide always follows the click. Pair them on a {#key}
// block: in:deckTabIn + out:deckTabOut.
export function deckTabOut(
  _node: Element,
  { duration = 130, dir = 1 }: { duration?: number; dir?: number } = {},
): TransitionConfig {
  if (reduced()) return { duration: 0 };
  return {
    duration,
    // out: t runs 1 → 0. Slide opposite the incoming pane, fade, soft blur up.
    css: (t: number, u: number) =>
      `transform: translateX(${(-dir * u * 18).toFixed(1)}px); opacity: ${t.toFixed(2)}; filter: brightness(${(1 + u * 0.5).toFixed(2)}) blur(${(u * 1.4).toFixed(2)}px);`,
  };
}

export function deckTabIn(
  _node: Element,
  // Acquire is delayed past the loss so they read as one re-tune, ~340ms total.
  { duration = 210, delay = 60, dir = 1 }: { duration?: number; delay?: number; dir?: number } = {},
): TransitionConfig {
  if (reduced()) return { duration: 0 };
  return {
    delay,
    duration,
    // in: t runs 0 → 1. Arrive from the travel direction, bloom + blur resolve.
    css: (t: number, u: number) =>
      `transform: translateX(${(dir * u * 22).toFixed(1)}px); opacity: ${Math.min(1, t * 1.4).toFixed(2)}; filter: brightness(${(1 + u * 0.7).toFixed(2)}) blur(${(u * 1.6).toFixed(2)}px);`,
  };
}
