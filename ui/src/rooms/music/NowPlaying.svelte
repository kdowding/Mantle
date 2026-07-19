<!-- Now-playing HUD hero — the visualizer canvas behind art/title, the peaks
     scrubber (the bars ARE the seek control), transport, and the
     scope / viz-mode / volume subrow. The two canvases are imperative islands:
     one rAF loop drives both off the live analyser + decoded peaks. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    music, togglePlay, nextSong, prevSong, seekTo, setVolume,
    toggleShuffle, toggleRepeat, toggleScope, cycleViz,
    getAnalyser, getCurrentPeaks, agentName, coverUrl, fmtTime,
  } from './music.svelte';
  import { drawViz, drawScrubber, resetVizTransients, hexToRgb, VIZ_LABELS, type RGB } from './viz';
  import { SVG } from './icons';

  let nowEl: HTMLDivElement;
  let waveEl: HTMLCanvasElement;
  let scrubEl: HTMLCanvasElement;

  // viz-mode button flashes on switch
  let vizFlash = $state(false);
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  function onCycleViz(): void {
    cycleViz();
    resetVizTransients(); // fresh canvas for the new mode
    vizFlash = true;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { vizFlash = false; }, 900);
  }

  // Click/drag anywhere on the peaks scrubber to seek.
  let dragging = false;
  function seekAt(clientX: number): void {
    const r = scrubEl.getBoundingClientRect();
    if (r.width > 0) seekTo((clientX - r.left) / r.width);
  }
  function onPointerDown(e: PointerEvent): void {
    dragging = true;
    try { scrubEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    seekAt(e.clientX);
  }
  function onPointerMove(e: PointerEvent): void {
    if (dragging) seekAt(e.clientX);
  }
  function endDrag(): void { dragging = false; }

  onMount(() => {
    const ctx = waveEl.getContext('2d');
    const sctx = scrubEl.getContext('2d');
    if (!ctx || !sctx) return;

    let frame = 0;
    let amp = 0.08; // eased play-state envelope
    let teal: RGB = [0, 212, 170];
    let purple: RGB = [184, 61, 255];
    let freqData: Uint8Array<ArrayBuffer> | null = null;
    let timeData: Uint8Array<ArrayBuffer> | null = null;
    let raf = 0;

    function resize(): void {
      // clientWidth/Height, NOT getBoundingClientRect — rects are squashed
      // while the stage's CRT scaleY transition plays over a fresh mount, and
      // ResizeObserver never refires after the transform settles (layout size
      // never changed), so the canvases stayed ~1px tall forever (found live).
      waveEl.width = Math.max(1, nowEl.clientWidth);
      waveEl.height = Math.max(1, nowEl.clientHeight);
      scrubEl.width = Math.max(1, scrubEl.clientWidth);
      scrubEl.height = Math.max(1, scrubEl.clientHeight);
    }
    const ro = new ResizeObserver(resize);
    ro.observe(nowEl);
    ro.observe(scrubEl);
    resize();

    function readColors(): void {
      const cs = getComputedStyle(document.documentElement);
      teal = hexToRgb(cs.getPropertyValue('--agent-accent')) ?? teal;
      purple = hexToRgb(cs.getPropertyValue('--accent-purple')) ?? purple;
    }
    readColors();

    function draw(): void {
      raf = requestAnimationFrame(draw);
      if (!music.open) return; // panel clipped while collapsed — skip the work
      const w = waveEl.width, h = waveEl.height;
      if (frame % 30 === 0) readColors();
      amp += ((music.isPlaying ? 1.0 : 0.12) - amp) * 0.04;
      const t = frame * 0.016;
      const analyser = getAnalyser();
      if (analyser) {
        if (!freqData || freqData.length !== analyser.frequencyBinCount) {
          freqData = new Uint8Array(analyser.frequencyBinCount);
          timeData = new Uint8Array(analyser.fftSize);
        }
        analyser.getByteFrequencyData(freqData);
        analyser.getByteTimeDomainData(timeData!);
      }
      drawViz(music.vizMode, {
        ctx: ctx!, w, h, teal, purple, amp, t,
        freqData, timeData, analyser, isPlaying: music.isPlaying,
      });
      const prog = music.duration ? Math.max(0, Math.min(1, music.progress / music.duration)) : 0;
      drawScrubber(sctx!, scrubEl.width, scrubEl.height, getCurrentPeaks(), prog, teal);
      frame++;
    }
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  });
</script>

<div class="music-now" bind:this={nowEl}>
  <canvas class="music-wave" bind:this={waveEl} aria-hidden="true"></canvas>
  <div class="music-now-inner">
    <div class="music-np-head">
      {#if music.current?.hasCover}
        <!-- album art beside the title (absent → title reclaims the width) -->
        <div class="music-np-art" aria-hidden="true"><img src={coverUrl(music.current)} alt="" /></div>
      {/if}
      <div class="music-np-meta">
        <div class="music-np-title">{music.current?.title ?? 'Nothing playing'}</div>
        {#if music.current}
          <div class="music-np-agent">{agentName(music.current.agentId)}</div>
        {/if}
      </div>
    </div>
    <canvas
      class="music-scrubber"
      bind:this={scrubEl}
      title="Seek"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={endDrag}
      onpointercancel={endDrag}
    ></canvas>
    <div class="music-times"><span>{fmtTime(music.progress)}</span><span>{fmtTime(music.duration)}</span></div>
    <div class="music-transport">
      <button class="music-tbtn" class:is-on={music.shuffle} type="button" title="Shuffle" onclick={toggleShuffle}>{@html SVG.shuffle}</button>
      <button class="music-tbtn" type="button" title="Previous" onclick={prevSong}>{@html SVG.prev}</button>
      <button class="music-tbtn music-play" class:is-playing={music.isPlaying} type="button" title="Play/Pause" onclick={togglePlay}>
        {@html music.isPlaying ? SVG.pause : SVG.play}
      </button>
      <button class="music-tbtn" type="button" title="Next" onclick={nextSong}>{@html SVG.next}</button>
      <button class="music-tbtn" class:is-on={music.repeat} type="button" title="Repeat current" onclick={toggleRepeat}>{@html SVG.repeat}</button>
    </div>
    <div class="music-subrow">
      <button class="music-scope" class:is-on={music.scope === 'current'} type="button" title="Queue scope" onclick={toggleScope}>{music.scope}</button>
      <button class="music-viz-btn" class:is-flash={vizFlash} type="button" title="Cycle visualizer mode" onclick={onCycleViz}>{VIZ_LABELS[music.vizMode]}</button>
      <input
        class="music-vol"
        type="range"
        min="0"
        max="1"
        step="0.01"
        title="Volume"
        value={music.volume}
        oninput={(e) => setVolume(parseFloat(e.currentTarget.value))}
      />
    </div>
  </div>
</div>

<style>
  .music-now {
    position: relative;
    padding: 15px 14px 14px;
    overflow: hidden;
    border-bottom: 1px solid var(--border);
    background:
      radial-gradient(125% 90% at 50% 100%, var(--accent-faint), transparent 70%),
      var(--bg-tertiary);
  }
  .music-wave { position: absolute; inset: 0; width: 100%; height: 100%; display: block; pointer-events: none; }
  .music-now-inner { position: relative; z-index: 1; }
  .music-np-head { display: flex; align-items: center; gap: 11px; }
  .music-np-art { flex: 0 0 auto; }
  .music-np-art img {
    width: 52px;
    height: 52px;
    object-fit: cover;
    display: block;
    border: 1px solid var(--accent-edge);
    box-shadow: 0 0 12px var(--accent-dim);
    clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px);
  }
  .music-np-meta { flex: 1; min-width: 0; }
  .music-np-title {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 16px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .music-np-agent {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 3px;
    min-height: 13px;
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--accent);
  }
  .music-np-agent::before {
    content: "";
    width: 6px;
    height: 6px;
    background: var(--accent);
    flex-shrink: 0;
    box-shadow: 0 0 5px var(--accent-glow);
    clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
  }

  /* Peaks scrubber — a SoundCloud-style waveform seekbar (canvas-drawn). */
  .music-scrubber {
    display: block;
    width: 100%;
    height: 40px;
    margin: 13px 0 4px;
    cursor: pointer;
    touch-action: none; /* drag-to-seek instead of scroll */
  }
  .music-times {
    display: flex;
    justify-content: space-between;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  /* ── Transport (custom HUD buttons) ────────────────────────────────────── */
  .music-transport { display: flex; align-items: center; justify-content: center; gap: 7px; margin-top: 13px; }
  .music-tbtn {
    width: 36px;
    height: 34px;
    display: grid;
    place-items: center;
    cursor: pointer;
    color: var(--text-secondary);
    background: var(--bg-surface);
    border: 1px solid var(--border-strong);
    clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
    transition: color 0.15s, border-color 0.15s, box-shadow 0.15s, background 0.15s;
  }
  .music-tbtn :global(svg) { width: 15px; height: 15px; display: block; }
  .music-tbtn:hover { color: var(--accent); border-color: var(--accent-edge); box-shadow: 0 0 10px var(--accent-dim); }
  .music-tbtn.is-on {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-dim);
    box-shadow: inset 0 0 12px var(--accent-dim), 0 0 8px var(--accent-dim);
  }
  /* center play button — the focal CTA: larger, hexagonal */
  .music-tbtn.music-play {
    width: 50px;
    height: 44px;
    color: var(--accent);
    background: var(--accent-faint);
    border-color: var(--accent-edge);
    clip-path: polygon(12px 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 12px 100%, 0 50%);
  }
  .music-tbtn.music-play :global(svg) { width: 17px; height: 17px; }
  .music-tbtn.music-play:hover { box-shadow: 0 0 16px var(--accent-glow); }
  .music-tbtn.music-play.is-playing { background: var(--accent-dim); box-shadow: 0 0 18px var(--accent-glow), inset 0 0 14px var(--accent-dim); }

  .music-subrow { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
  .music-scope {
    font-family: var(--font-mono);
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    padding: 4px 9px;
    cursor: pointer;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid var(--border);
    clip-path: polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px);
    transition: color 0.15s, border-color 0.15s, box-shadow 0.15s;
  }
  .music-scope:hover { color: var(--text-secondary); border-color: var(--accent-edge); }
  .music-scope.is-on { color: var(--accent); border-color: var(--accent-edge); box-shadow: inset 0 0 8px var(--accent-dim); }
  /* visualizer mode button — shows the current mode, click cycles. Flashes on switch. */
  .music-viz-btn {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    padding: 4px 9px;
    cursor: pointer;
    color: var(--accent);
    background: var(--accent-faint);
    border: 1px solid var(--border);
    clip-path: polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px);
    transition: color 0.15s, border-color 0.15s, box-shadow 0.15s, background 0.15s;
  }
  .music-viz-btn:hover { border-color: var(--accent-edge); background: var(--accent-dim); }
  .music-viz-btn.is-flash { border-color: var(--accent); background: var(--accent-dim); box-shadow: 0 0 12px var(--accent-dim); }
  .music-vol {
    flex: 1;
    height: 4px;
    cursor: pointer;
    -webkit-appearance: none;
    appearance: none;
    background: var(--border-strong);
    outline: none;
  }
  .music-vol::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 11px;
    height: 15px;
    cursor: pointer;
    background: var(--accent);
    box-shadow: 0 0 6px var(--accent-glow);
    clip-path: polygon(50% 0, 100% 28%, 100% 72%, 50% 100%, 0 72%, 0 28%);
  }
  .music-vol::-moz-range-thumb {
    width: 11px;
    height: 15px;
    cursor: pointer;
    border: none;
    background: var(--accent);
    box-shadow: 0 0 6px var(--accent-glow);
    clip-path: polygon(50% 0, 100% 28%, 100% 72%, 50% 100%, 0 72%, 0 28%);
  }
</style>
