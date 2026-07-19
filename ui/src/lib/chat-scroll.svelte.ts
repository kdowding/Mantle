// Shared claude.ai-style scroll model for EVERY chat surface — the 1:1 chat
// (views/Chat), the systems-deck assist dock (rooms/assist/AssistDock), and
// channel rooms (rooms/channel/ChannelView). Sending anchors YOUR prompt just
// below the top of the pane; the reply then streams in BELOW it and NEVER grabs
// the scroll — following the tail is strictly opt-in (scroll back to the bottom,
// or hit the ▼ chip). Lifted verbatim from views/Chat.svelte's scroll logic so
// the three surfaces share ONE behaviour and can't drift.
//
// Wiring a surface (see the three call sites):
//   const sc = new ChatScroll(() => scrollerEl);
//   on send:        await tick(); const el = <the just-sent user row>; if (el) sc.anchorSend(el);
//   on stream/grow: sc.onWrite();            // a reveal-island write hook OR a reactive $effect
//   on load/switch: sc.reset();              // the first onWrite then lands at the bottom
//   markup:         onscroll/onwheel/ontouchmove → sc.onScroll() / sc.onWheel(e) / sc.onTouchMove()
//                   class:has-tail={streaming || lastIsUser || sc.anchorHold}   (+ the ::after spacer)
//                   {#if sc.showJump}<button onclick={() => sc.jumpToBottom()}>▼ latest</button>{/if}

const FOLLOW_GAP = 48; // within this of the content bottom → re-arm follow
const JUMP_GAP = 240; // past this from the content bottom → surface the ▼ chip
const SELF_SCROLL_MS = 140; // ignore scroll events caused by our own auto-scrolls
const ANCHOR_PAD = 18; // px of breathing room above the anchored prompt
const GAP_PAD = 14; // contentGap fudge (parity with the old inline math)

export class ChatScroll {
  // Reactive surface the markup reads.
  showJump = $state(false);
  anchorHold = $state(false); // once a send anchors, the tail spacer stays for this view

  #getEl: () => HTMLElement | null | undefined;
  #autoFollow = true; // pin the tail on writes (opt-in; a send turns it off)
  #lastAutoAt = 0; // perf ts of our last programmatic scroll (self-scroll guard)
  #glideRaf = 0;

  constructor(getEl: () => HTMLElement | null | undefined) {
    this.#getEl = getEl;
  }

  // ── geometry ──────────────────────────────────────────────────────────────
  #lastChild(): HTMLElement | null {
    const sc = this.#getEl();
    if (!sc) return null;
    for (let i = sc.children.length - 1; i >= 0; i--) {
      const el = sc.children[i];
      if (el instanceof HTMLElement) return el;
    }
    return null;
  }
  /* >0 — content extends below the fold; <0 — it ends above it. */
  #gap(): number {
    const sc = this.#getEl();
    const last = this.#lastChild();
    if (!sc || !last) return 0;
    return last.getBoundingClientRect().bottom - sc.getBoundingClientRect().bottom + GAP_PAD;
  }
  #scrollBy(px: number): void {
    const sc = this.#getEl();
    if (!sc) return;
    this.#lastAutoAt = performance.now();
    sc.scrollTop += px;
  }

  // Hand-rolled glide — native smooth scroll STALLS while a streaming island
  // mutates layout every frame (frozen ~2s then a teleport, observed live). Each
  // frame writes scrollTop directly and re-stamps the self-scroll guard, so
  // neither the stream nor our own scroll events disturb it.
  #glideTo(target: number, ms = 340): void {
    const sc = this.#getEl();
    if (!sc) return;
    cancelAnimationFrame(this.#glideRaf);
    const start = sc.scrollTop;
    const dist = target - start;
    if (Math.abs(dist) < 2) return;
    const t0 = performance.now();
    const tick = (): void => {
      const el = this.#getEl();
      if (!el) return;
      const t = Math.min(1, (performance.now() - t0) / ms);
      const ease = 1 - Math.pow(1 - t, 3); // easeOutCubic
      this.#lastAutoAt = performance.now();
      el.scrollTop = start + dist * ease;
      if (t < 1) this.#glideRaf = requestAnimationFrame(tick);
    };
    this.#glideRaf = requestAnimationFrame(tick);
  }

  // ── conversation lifecycle ────────────────────────────────────────────────
  // New conversation (session / agent / channel switch): drop the tail room and
  // re-arm follow so the first content load lands at the bottom (via onWrite).
  reset(): void {
    cancelAnimationFrame(this.#glideRaf);
    this.anchorHold = false;
    this.#autoFollow = true;
    this.showJump = false;
  }

  // Park the view at an element's top, instantly, WITHOUT following — the
  // session-entrance landing (the windows pop and text types in place; the view
  // never moves during the show).
  parkAt(el: HTMLElement): void {
    const sc = this.#getEl();
    if (!sc) return;
    this.#lastAutoAt = performance.now();
    sc.scrollTop = Math.max(0, el.offsetTop - GAP_PAD);
    this.#autoFollow = false;
  }

  // A send: glide YOUR message to sit just below the top of the pane and DON'T
  // arm follow — the reply grows below the fold while the view holds at your
  // prompt (the claude.ai anchor). Free scrolling stays available throughout;
  // a streaming reply never moves the view on its own.
  anchorSend(el: HTMLElement): void {
    const sc = this.#getEl();
    if (!sc) return;
    // offsetTop, NOT getBoundingClientRect — rects are squashed while a CRT/scale
    // animation runs; layout coordinates don't care about transforms.
    const target = Math.max(0, el.offsetTop - ANCHOR_PAD);
    if (target > sc.scrollTop) this.#glideTo(target);
    this.#autoFollow = false;
    this.anchorHold = true; // tail room stays for the rest of this view
    this.showJump = false;
  }

  // ── content growth (a stream tick or a new row) ────────────────────────────
  // Opted-in followers (at the bottom / via the chip) get the tail pinned;
  // everyone else just gets the ▼ chip once the reply outgrows the fold. A
  // streaming reply NEVER scrolls a reader who hasn't opted in.
  onWrite(): void {
    const gap = this.#gap();
    if (this.#autoFollow) {
      if (gap > 0) this.#scrollBy(gap);
    } else {
      this.showJump = gap > JUMP_GAP;
    }
  }

  jumpToBottom(): void {
    const gap = this.#gap();
    if (gap !== 0) this.#scrollBy(gap);
    this.#autoFollow = true;
    this.showJump = false;
  }

  // Land at the absolute content bottom WITHOUT the rect math — scrollHeight is a
  // layout property, immune to the CRT scale transition that squashes
  // getBoundingClientRect on a fresh view mount (which left channel/assist loads
  // stuck at the top). For the LOAD path only — a finished transcript carries no
  // tail spacer, so scrollHeight is the content bottom.
  landAtBottom(): void {
    const sc = this.#getEl();
    if (!sc) return;
    this.#lastAutoAt = performance.now();
    sc.scrollTop = sc.scrollHeight;
    this.#autoFollow = true;
    this.showJump = false;
  }

  // ── input ──────────────────────────────────────────────────────────────────
  onWheel(e: WheelEvent): void {
    if (e.deltaY < 0) this.#autoFollow = false; // reading back → release the tail
  }
  onTouchMove(): void {
    // Touch drags can't be told from our own follow writes via scroll events;
    // release on any touch scroll — onScroll re-arms the moment they're back.
    this.#autoFollow = false;
  }
  onScroll(): void {
    if (performance.now() - this.#lastAutoAt < SELF_SCROLL_MS) {
      this.showJump = false; // our own scroll always lands on the latest
      return;
    }
    const gap = this.#gap();
    this.#autoFollow = gap < FOLLOW_GAP; // back at (or past) the bottom → re-arm
    this.showJump = gap > JUMP_GAP;
  }
}
