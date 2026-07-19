<script lang="ts">
  // Boot moment — a beat of character static + the brand
  // cipher-decoding + a link line, then the screen "loses signal" into the
  // app. Once per TAB session (sessionStorage) so dev reloads skip it; click
  // anywhere skips; prefers-reduced-motion never sees it (App gates).
  import { onMount } from 'svelte';
  import { crtLoss } from '../lib/crt';
  import { cipher } from '../lib/cipher';

  let { ondone }: { ondone: () => void } = $props();

  let canvas: HTMLCanvasElement;
  let fading = $state(false);
  let linkLine = $state(false);

  const STATIC_CHARS = '01▓▒░<>/{}#$%&*+=-';

  onMount(() => {
    // ── Character static (full-screen canvas) ───────────────────────────────
    const ctx = canvas.getContext('2d');
    let raf = 0;
    let frame = 0;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#00d4aa';
    const draw = (): void => {
      raf = requestAnimationFrame(draw);
      frame++;
      if (frame % 3 !== 0 || !ctx) return;
      const w = (canvas.width = canvas.clientWidth);
      const h = (canvas.height = canvas.clientHeight);
      const cell = 14;
      ctx.clearRect(0, 0, w, h);
      ctx.font = `${cell}px "Share Tech Mono", monospace`;
      for (let y = 0; y < h; y += cell * 1.3) {
        for (let x = 0; x < w; x += cell) {
          if (Math.random() > 0.22) continue;
          ctx.globalAlpha = 0.03 + Math.random() * 0.12;
          ctx.fillStyle = accent;
          ctx.fillText(STATIC_CHARS[Math.floor(Math.random() * STATIC_CHARS.length)], x, y);
        }
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);

    // ── Sequence: brand decodes immediately; link line at 450ms; static
    // fades at 650ms; signal-loss exit at 900ms. ─────────────────────────────
    const t1 = setTimeout(() => (linkLine = true), 450);
    const t2 = setTimeout(() => (fading = true), 650);
    const t3 = setTimeout(ondone, 950);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
    };
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="boot" out:crtLoss={{ duration: 220 }} onclick={ondone}>
  <canvas bind:this={canvas} class="boot-static" class:fading></canvas>
  <div class="boot-card">
    <div class="boot-brand" use:cipher={'REV://MANTLE'}></div>
    <div class="boot-line" class:on={linkLine}>◦ establishing link<span class="boot-cursor">▌</span></div>
  </div>
</div>

<style>
  .boot {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-primary);
    cursor: pointer;
  }
  .boot-static {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    transition: opacity 0.3s ease-out;
  }
  .boot-static.fading { opacity: 0; }

  .boot-card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
  }
  .boot-brand {
    font-family: var(--font-display);
    font-size: clamp(26px, 5vw, 44px);
    font-weight: 700;
    letter-spacing: 6px;
    color: var(--text-primary);
    text-shadow:
      -1px 0 0 rgba(255, 45, 124, 0.4),
      1px 0 0 rgba(0, 200, 255, 0.4),
      0 0 26px var(--accent-glow);
    min-height: 1.2em;
    white-space: pre;
  }
  .boot-line {
    font-family: var(--font-terminal);
    font-size: 11px;
    letter-spacing: 2.5px;
    text-transform: uppercase;
    color: var(--accent);
    opacity: 0;
    transition: opacity 0.2s;
  }
  .boot-line.on { opacity: 0.85; }
  .boot-cursor { animation: boot-blink 0.7s step-end infinite; margin-left: 2px; }
  @keyframes boot-blink {
    50% { opacity: 0; }
  }
</style>
