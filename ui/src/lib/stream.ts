// Manual-DOM streaming islands. The reveal hot path lives OUTSIDE Svelte's
// reactivity: the bound node's children are written by the smd parser here, and
// Svelte must never manage them (the one rule from the rebuild plan).
//
// Ported from app.js's reveal clock: network arrival (push) is decoupled from
// on-screen reveal. text deltas append to `raw` at network pace; a rAF loop
// drains `raw` into the smd parser at a smooth, adaptive rate that stays a
// beat behind live — that deliberate lag is the jitter buffer.
//
// `createIsland()` is the factory — each instance is one independent reveal
// (the channel room runs one per live bubble, since a volley can have one
// speaker's tail still draining as the next opens). The 1:1 chat's island is
// the module singleton below, exported under its original names.
import * as SMD from './smd.js';
import type { Parser, Renderer, RendererData } from './smd.js';

// Reveal-clock tuning (chars = cps * dt, so speed is smooth regardless of frame
// cadence). Baseline ~60 cps reads naturally; a backlog raises cps to absorb it
// within CATCHUP_SEC; after end the remainder drains within END_DRAIN_SEC; the
// prime gate holds the first paint briefly to build runway against jitter.
const REVEAL_PRIME_MS = 120;
const REVEAL_PRIME_CHARS = 40;
const REVEAL_BASE_CPS = 60;
const REVEAL_CATCHUP_SEC = 0.8;
const REVEAL_END_DRAIN_SEC = 0.3;

// House-styled smd renderer: links open in a new tab, images are lightbox-
// eligible. Branch on the created node's tag, not smd's token constants.
function chatRenderer(root: HTMLElement): Renderer {
  const r = SMD.default_renderer(root);
  const baseAdd = r.add_token;
  r.add_token = (data: RendererData, type: number) => {
    baseAdd(data, type);
    const created = data.nodes[data.index];
    if (created && created.nodeType === 1) {
      const el = created as Element;
      if (el.tagName === 'A') {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener');
      } else if (el.tagName === 'IMG') {
        el.classList.add('msg-image');
        el.setAttribute('loading', 'lazy');
      }
    }
  };
  return r;
}

export interface Island {
  /** Bind the node a run renders into (order-independent with push). */
  attach(node: HTMLElement): void;
  /** Append streamed text; the reveal clock paces it onto the parser. */
  push(text: string): void;
  /** Turn ended — drain the remaining buffer, then fire onDone. */
  end(): void;
  /** Flush + finalize the current run immediately (tool interrupt). */
  interrupt(): void;
  /** Tear down all state (turn start / abort). */
  reset(): void;
  setOnWrite(fn: (() => void) | null): void;
  setOnDone(fn: (() => void) | null): void;
}

// Fires on EVERY island's writes (chat singleton, channel bubbles, voice).
// Chat.svelte registers its pinned-scroll follow here so islands it didn't
// create (a room's per-bubble islands) still keep the view pinned.
let onWriteGlobal: (() => void) | null = null;
export function setOnWriteGlobal(fn: (() => void) | null): void {
  onWriteGlobal = fn;
}
// Clear ONLY if `fn` is still the registered hook. Surfaces that swap the global
// hook (chat ⇄ channel) overlap during the CRT stage transition — the outgoing
// view's delayed cleanup must not null the incoming view's freshly-set hook.
export function clearOnWriteGlobal(fn: () => void): void {
  if (onWriteGlobal === fn) onWriteGlobal = null;
}

// opts.fixedCps: constant-velocity reveal (entrance replays) — skips the
// adaptive catch-up/drain math entirely, so the pace never decays toward the
// end the way remaining-proportional pacing does. Live turns omit it.
export function createIsland(opts: { fixedCps?: number } = {}): Island {
  const st = {
    raw: '',                          // all text received for the current run
    shown: 0,                         // chars already written to the parser
    parser: null as Parser | null,    // smd parser bound to `node` (lazy)
    node: null as HTMLElement | null, // the element this run renders into
    ended: false,                     // end() seen for this turn
    primed: false,                    // prime window elapsed → reveal started
    startedAt: 0,                     // perf ts of first frame (prime gate)
    lastFrameT: 0,                    // perf ts of previous frame (dt)
    rafId: null as number | null,
  };

  let onWrite: (() => void) | null = null;
  let onDone: (() => void) | null = null;

  // Tear down reveal state. parser_end flushes any trailing partial token into
  // the DOM before we drop it.
  function teardown(): void {
    if (st.rafId != null) { cancelAnimationFrame(st.rafId); st.rafId = null; }
    if (st.parser) { try { SMD.parser_end(st.parser); } catch { /* ignore */ } }
    st.raw = '';
    st.shown = 0;
    st.parser = null;
    st.node = null;
    st.ended = false;
    st.primed = false;
    st.startedAt = 0;
    st.lastFrameT = 0;
  }

  function scheduleReveal(): void {
    if (st.rafId == null) st.rafId = requestAnimationFrame(revealFrame);
  }

  // One reveal frame: feed a surrogate-safe slice of pending text to smd at the
  // current adaptive rate, then reschedule / idle / finalize.
  function revealFrame(now: number): void {
    st.rafId = null;
    const node = st.node;
    if (!node) return;

    const parser = (st.parser ??= SMD.parser(chatRenderer(node)));
    const pending = st.raw.length - st.shown;

    // Prime gate: hold the first paint until some runway buffers or a short
    // window passes (skipped once the turn has already ended).
    if (!st.primed) {
      if (st.startedAt === 0) st.startedAt = now;
      if (!st.ended && pending < REVEAL_PRIME_CHARS && now - st.startedAt < REVEAL_PRIME_MS) {
        scheduleReveal();
        return;
      }
      st.primed = true;
      st.lastFrameT = now;
    }

    if (pending <= 0) {
      if (st.ended) drained();
      // else idle — push restarts the loop when more text lands.
      return;
    }

    const dt = Math.min(0.05, (now - st.lastFrameT) / 1000); // clamp tab-switch gaps
    st.lastFrameT = now;

    let cps = Math.max(REVEAL_BASE_CPS, pending / REVEAL_CATCHUP_SEC);
    if (st.ended) cps = Math.max(cps, pending / REVEAL_END_DRAIN_SEC);
    if (opts.fixedCps) cps = opts.fixedCps; // linear — constant to the last char
    let n = Math.max(1, Math.round(cps * dt));
    if (n > pending) n = pending;

    // Don't split a surrogate pair: extend to include the trailing low
    // surrogate so the parser never receives a lone half.
    let end = st.shown + n;
    const lastCode = st.raw.charCodeAt(end - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff && end < st.raw.length) end++;

    SMD.parser_write(parser, st.raw.slice(st.shown, end));
    st.shown = end;
    onWrite?.();
    onWriteGlobal?.();

    if (st.shown < st.raw.length || !st.ended) scheduleReveal();
    else drained();
  }

  // Buffer fully revealed AND turn ended → finalize the parser + notify.
  function drained(): void {
    teardown();
    onDone?.();
  }

  return {
    // Begin a run into `node`. reset() has already cleared turn state, so this
    // only binds the node + (re)starts the reveal — it deliberately does NOT
    // touch `raw`, so a delta buffered before mount still reveals.
    attach(node: HTMLElement): void {
      st.node = node;
      st.primed = false;
      st.startedAt = 0;
      st.lastFrameT = 0;
      scheduleReveal();
    },

    push(text: string): void {
      st.raw += text;
      scheduleReveal();
    },

    // end: mark the turn ended and let the loop drain the buffer (eased out
    // over REVEAL_END_DRAIN_SEC) before firing onDone — no all-at-once pop. A
    // turn that ends with no open run has nothing to drain, so finalize now.
    end(): void {
      st.ended = true;
      if (!st.node) { drained(); return; }
      scheduleReveal();
    },

    // A tool / attachment interrupts text: flush the current run's remaining
    // buffer + finalize its parser immediately, then clear so the next
    // attach() starts a fresh run. `ended` stays (per-turn).
    interrupt(): void {
      if (st.rafId != null) { cancelAnimationFrame(st.rafId); st.rafId = null; }
      if (st.parser) {
        if (st.shown < st.raw.length) {
          try { SMD.parser_write(st.parser, st.raw.slice(st.shown)); } catch { /* ignore */ }
        }
        try { SMD.parser_end(st.parser); } catch { /* ignore */ }
      }
      st.raw = '';
      st.shown = 0;
      st.parser = null;
      st.node = null;
      st.primed = false;
      st.startedAt = 0;
      st.lastFrameT = 0;
    },

    reset(): void { teardown(); },
    setOnWrite(fn: (() => void) | null): void { onWrite = fn; },
    setOnDone(fn: (() => void) | null): void { onDone = fn; },
  };
}

// One-shot static render for transcript replay — same parser + house renderer
// as live streaming, so replayed turns and fresh turns can't drift in markup.
export function renderStatic(node: HTMLElement, text: string): void {
  const parser = SMD.parser(chatRenderer(node));
  SMD.parser_write(parser, text);
  SMD.parser_end(parser);
}

// ── The 1:1 chat's island (module singleton, original export names) ──────────
const chatIsland = createIsland();

export function setOnWrite(fn: (() => void) | null): void { chatIsland.setOnWrite(fn); }
export function setOnDone(fn: (() => void) | null): void { chatIsland.setOnDone(fn); }
export function resetTurn(): void { chatIsland.reset(); }
export function attach(node: HTMLElement): void { chatIsland.attach(node); }
export function pushDelta(text: string): void { chatIsland.push(text); }
export function endTurn(): void { chatIsland.end(); }
export function interrupt(): void { chatIsland.interrupt(); }
