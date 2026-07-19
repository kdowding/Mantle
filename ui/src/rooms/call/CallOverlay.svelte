<script lang="ts">
  // Full call panel — replaces the chat surface while a call is live
  // (ProfileBar + sidebar stay). The avatar's waveform ring + amplitude
  // glow are imperative (canvas + a CSS var written from a rAF loop, port
  // of realtime.js's animation); everything else is reactive Svelte.
  import { untrack } from 'svelte';
  import { ui } from '../../lib/state.svelte';
  import { chat } from '../../lib/state.svelte';
  import {
    call, endCall, toggleMute, sendCallText, activeAnalyser, maybeFinishPlaybackDrain, COST_PER_MIN,
  } from './call.svelte';

  const WAVE_BAR_COUNT = 48;
  const WAVE_FRAME_MS = 1000 / 30; // visuals capped at 30fps; audio is realtime
  const WAVE_MAX_DPR = 1.5;

  const agentName = $derived(ui.profile?.name ?? ui.agents.find((a) => a.id === ui.currentAgentId)?.name ?? 'Agent');
  const avatarUrl = $derived(ui.profile?.avatarUrl ?? null);
  let imgFailed = $state(false);

  // Timer + cost tick (legacy: 500ms interval from the server's startedAt).
  let nowTick = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (nowTick = Date.now()), 500);
    return () => clearInterval(t);
  });
  const elapsedMs = $derived(call.startedAt ? Math.max(0, nowTick - call.startedAt) : 0);
  const timer = $derived.by(() => {
    const total = Math.floor(elapsedMs / 1000);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  });
  const cost = $derived(`$${((elapsedMs / 60000) * COST_PER_MIN).toFixed(2)}`);

  // Leaving the call's context ends it: agent switch or selecting a session
  // mid-call (sidebar stays clickable under the overlay).
  const startAgent = untrack(() => ui.currentAgentId);
  const startSession = untrack(() => chat.sessionId);
  $effect(() => {
    if (ui.currentAgentId !== startAgent || chat.sessionId !== startSession) void endCall();
  });
  // WS drop kills the server-side bridge — reflect it and wind down.
  $effect(() => {
    if (!ui.wsConnected && call.status !== 'disconnected') {
      call.status = 'disconnected';
      call.statusText = 'Connection lost';
      setTimeout(() => void endCall(true), 1500);
    }
  });

  // Transcript auto-scroll.
  let transcriptEl = $state<HTMLDivElement>();
  $effect(() => {
    void call.turns.length;
    void call.turns[call.turns.length - 1]?.text;
    if (transcriptEl) transcriptEl.scrollTop = transcriptEl.scrollHeight;
  });

  // ── Avatar ring animation (imperative; port of realtime.js) ─────────────
  let wrapEl = $state<HTMLDivElement>();
  let canvasEl = $state<HTMLCanvasElement>();

  $effect(() => {
    const wrap = wrapEl;
    const canvas = canvasEl;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const levels = new Float32Array(WAVE_BAR_COUNT);
    const buf = new Uint8Array(256);
    let easedAmp = 0;
    let lastFrameAt = 0;
    let cw = 0, chh = 0, cdpr = 1;
    let rafId: number | null = null;
    // Voice band: bins 2–72 ≈ 90Hz–3.4kHz at fftSize 512 / 24kHz.
    const bandStart = 2;
    const bandEnd = 72;
    const pulse01 = (x: number): number => (Math.sin(x) + 1) / 2;

    const synthetic = (now: number): number => {
      const t = now / 1000;
      if (call.status === 'connecting') return 0.18 + 0.22 * pulse01(t * 2.1) + 0.1 * pulse01(t * 4.2 + 0.35);
      if (call.status === 'thinking') return 0.1 + 0.16 * pulse01(t * 0.72) + 0.06 * pulse01(t * 1.33 + 0.8);
      if (call.status === 'listening') return 0.045;
      return 0;
    };

    const accent = (): string => {
      const v = getComputedStyle(document.documentElement);
      return v.getPropertyValue('--agent-accent').trim() || v.getPropertyValue('--accent').trim() || '#00d4aa';
    };

    const draw = (raw: number): void => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, WAVE_MAX_DPR);
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (cw !== width || chh !== height || cdpr !== dpr) {
        cw = width; chh = height; cdpr = dpr;
        canvas.width = Math.max(1, Math.round(width * dpr));
        canvas.height = Math.max(1, Math.round(height * dpr));
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const radius = parseFloat(getComputedStyle(wrap).getPropertyValue('--wave-radius')) || (width < 260 ? 76 : 128);
      const speaking = call.status === 'speaking';
      const thinking = call.status === 'thinking';
      const baseH = width < 260 ? 7 : 8;
      const extraH = width < 260 ? (speaking ? 20 : 13) : (speaking ? 30 : 20);
      const barW = width < 260 ? (speaking ? 2.6 : 2.1) : (speaking ? 3.3 : 2.5);
      const color = accent();

      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < levels.length; i++) {
        const level = levels[i] || 0;
        const angle = (i / levels.length) * Math.PI * 2;
        const h = baseH + level * extraH + raw * (speaking ? 5 : 2);
        ctx.save();
        ctx.rotate(angle);
        ctx.globalAlpha = Math.min(0.88, 0.16 + level * 0.62 + raw * 0.18);
        ctx.fillStyle = thinking ? 'rgba(184, 61, 255, 0.82)' : color;
        ctx.beginPath();
        ctx.moveTo(-barW / 2, -radius);
        ctx.lineTo(barW / 2, -radius);
        ctx.lineTo(barW * 0.28, -radius - h + 4);
        ctx.lineTo(0, -radius - h);
        ctx.lineTo(-barW * 0.28, -radius - h + 4);
        ctx.closePath();
        ctx.fill();
        if (speaking && level > 0.28) {
          ctx.globalAlpha = Math.min(0.56, level * 0.5);
          ctx.fillStyle = 'rgba(255, 45, 124, 0.92)';
          ctx.beginPath();
          ctx.moveTo(-barW * 0.42, -radius - h + 6);
          ctx.lineTo(0, -radius - h - 2);
          ctx.lineTo(barW * 0.42, -radius - h + 6);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }
      ctx.restore();
    };

    const tick = (now: number): void => {
      if (!lastFrameAt || now - lastFrameAt >= WAVE_FRAME_MS) {
        lastFrameAt = now;
        let raw = 0;
        const analyser = activeAnalyser();
        if (analyser) {
          analyser.getByteFrequencyData(buf);
          const end = Math.min(bandEnd, buf.length);
          let peak = 0, sum = 0;
          for (let i = bandStart; i < end; i++) {
            if (buf[i] > peak) peak = buf[i];
            sum += buf[i];
          }
          const avg = sum / Math.max(1, end - bandStart) / 255;
          raw = Math.min(1, Math.pow((peak / 255) * 0.78 + avg * 0.38, 0.78));
        } else {
          raw = synthetic(now);
        }
        // Fast attack, slow release (~250ms) — voice-envelope feel.
        easedAmp = raw > easedAmp ? easedAmp * 0.3 + raw * 0.7 : easedAmp * 0.86 + raw * 0.14;
        wrap.style.setProperty('--call-amp', easedAmp.toFixed(3));

        const half = Math.ceil(WAVE_BAR_COUNT / 2);
        const phaseBase = now / (call.status === 'speaking' ? 132 : 185);
        for (let i = 0; i < WAVE_BAR_COUNT; i++) {
          let target = 0;
          if (analyser) {
            const mirrored = i < half ? i : WAVE_BAR_COUNT - i - 1;
            const t = mirrored / Math.max(1, half - 1);
            const bin = Math.min(buf.length - 2, Math.round(bandStart + t * (bandEnd - bandStart)));
            const local = ((buf[bin] || 0) * 0.68 + (buf[bin + 1] || 0) * 0.32) / 255;
            const floor = call.status === 'speaking' ? raw * 0.32 : raw * 0.22;
            const gain = call.status === 'speaking' ? 1.58 : 1.34;
            target = Math.min(1, Math.pow(Math.max(local, floor) * gain, 0.74));
          } else {
            const phase = (i / WAVE_BAR_COUNT) * Math.PI * 2;
            const ripple = 0.58 * pulse01(phase + phaseBase) + 0.42 * pulse01(phase * 2.7 - phaseBase * 0.72);
            const statusGain = call.status === 'connecting' ? 1.0 : call.status === 'thinking' ? 0.72 : 0.24;
            target = Math.min(1, raw * (0.38 + ripple * 0.72) * statusGain);
          }
          if (call.status === 'listening' && call.muted) target *= 0.18;
          const prev = levels[i] || 0;
          levels[i] = target > prev ? prev * 0.24 + target * 0.76 : prev * 0.84 + target * 0.16;
        }
        draw(raw);
      }
      maybeFinishPlaybackDrain();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  });

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCallText();
    }
  }
</script>

<div class="call-panel" data-status={call.status}>
  <div class="stagewrap">
    <div class="avatar-wrap" bind:this={wrapEl}>
      <div class="halo"></div>
      <canvas class="waveform" bind:this={canvasEl}></canvas>
      <div class="avatar-shell">
        {#if avatarUrl && !imgFailed}
          <img src={avatarUrl} alt="" onerror={() => (imgFailed = true)} />
        {:else}
          <div class="avatar-fallback">{agentName.charAt(0).toUpperCase()}</div>
        {/if}
      </div>
    </div>

    <div class="name">{agentName}</div>
    <div class="status">{call.statusText}</div>
    <div class="meta">
      <span class="timer">{timer}</span>
      <span class="dotsep">·</span>
      <span class="cost">{cost}</span>
      {#if call.muted}<span class="dotsep">·</span><span class="mutednote">mic muted</span>{/if}
    </div>

    <div class="controls">
      <button class="ctl mute" class:is-muted={call.muted} type="button" title={call.muted ? 'Mic muted - click to unmute' : 'Mic on - click to mute'} onclick={toggleMute}>
        {call.muted ? '🔇' : '🎙'}
      </button>
      <button class="ctl end" type="button" title="End call" onclick={() => void endCall()}>✕ End</button>
    </div>
  </div>

  <div class="transcript">
    <div class="t-body" bind:this={transcriptEl}>
      {#each call.turns as t (t.id)}
        <div class="turn {t.kind}">
          <span class="role">{t.kind === 'user' ? 'You' : t.kind === 'assistant' ? agentName : 'Error'}</span>
          <span class="text">{t.text}</span>
        </div>
      {/each}
      {#if call.turns.length === 0}
        <div class="t-empty">Say something - or type below.</div>
      {/if}
    </div>
    <div class="t-inputrow">
      <input
        class="t-input"
        type="text"
        bind:value={call.draft}
        placeholder="Type instead of speaking…"
        onkeydown={onKey}
      />
      <button class="t-send" type="button" disabled={!call.draft.trim()} onclick={sendCallText}>▶</button>
    </div>
  </div>
</div>

<style>
  .call-panel {
    height: 100%;
    min-height: 0;
    display: grid;
    grid-template-columns: 1.2fr 1fr;
    gap: 18px;
    padding: 22px 28px;
  }

  .stagewrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 0;
  }

  .avatar-wrap {
    position: relative;
    width: 320px;
    height: 320px;
    --wave-radius: 118px;
    --call-amp: 0;
    margin-bottom: 14px;
  }
  .halo {
    position: absolute;
    inset: -10px;
    border-radius: 50%;
    background:
      radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--agent-accent) 16%, transparent) 0%, transparent 62%),
      radial-gradient(circle at 34% 36%, rgba(184, 61, 255, 0.13) 0%, transparent 48%),
      radial-gradient(circle at 70% 68%, rgba(255, 45, 124, 0.1) 0%, transparent 52%);
    opacity: calc(0.2 + var(--call-amp) * 0.3);
    transform: scale(calc(0.94 + var(--call-amp) * 0.1));
    transition: opacity 90ms ease-out, transform 90ms ease-out;
    will-change: opacity, transform;
    pointer-events: none;
  }
  [data-status='speaking'] .halo {
    opacity: calc(0.26 + var(--call-amp) * 0.46);
    transform: scale(calc(0.98 + var(--call-amp) * 0.16));
  }
  [data-status='disconnected'] .avatar-wrap { --call-amp: 0; }

  .waveform { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }

  .avatar-shell {
    position: absolute;
    inset: 50%;
    width: 176px;
    height: 176px;
    transform: translate(-50%, -50%) scale(calc(1 + var(--call-amp) * 0.025));
    border-radius: 50%;
    overflow: hidden;
    border: 1.5px solid color-mix(in srgb, var(--agent-accent) 55%, transparent);
    box-shadow:
      0 0 26px color-mix(in srgb, var(--agent-accent) 22%, transparent),
      inset 0 0 24px rgba(255, 255, 255, 0.05);
    transition: transform 90ms ease-out, box-shadow 160ms ease;
    display: grid;
    place-items: center;
    background: var(--bg-tertiary);
  }
  .avatar-shell img { width: 100%; height: 100%; object-fit: cover; }
  .avatar-fallback {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 64px;
    color: var(--agent-accent);
  }

  .name {
    font-family: var(--font-display);
    font-size: 24px;
    font-weight: 700;
    letter-spacing: 1px;
    color: var(--agent-accent);
  }
  .status {
    font-family: var(--font-display);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 2px;
    color: var(--text-secondary);
  }
  [data-status='thinking'] .status { color: var(--accent-purple); }
  [data-status='disconnected'] .status { color: var(--text-muted); }

  .meta { display: flex; gap: 8px; font-family: var(--font-mono); font-size: 12px; color: var(--text-muted); }
  .dotsep { opacity: 0.5; }
  .mutednote { color: var(--warning); }

  .controls { display: flex; gap: 12px; margin-top: 16px; }
  .ctl {
    padding: 9px 18px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    font-family: var(--font-display);
    font-size: 13px;
    letter-spacing: 1px;
    cursor: pointer;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
    transition: border-color 0.15s, color 0.15s, background 0.15s;
  }
  .ctl:hover { border-color: var(--accent); color: var(--accent); }
  .ctl.mute.is-muted { border-color: var(--warning); color: var(--warning); background: rgba(255, 170, 0, 0.06); }
  .ctl.end { border-color: rgba(255, 45, 124, 0.4); color: var(--error); }
  .ctl.end:hover { border-color: var(--error); background: rgba(255, 45, 124, 0.1); }

  .transcript {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--border);
    padding-left: 18px;
  }
  .t-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 6px 2px; }
  .t-empty { margin: auto; color: var(--text-muted); font-size: 13px; }
  .turn { display: flex; flex-direction: column; gap: 2px; }
  .role {
    font-family: var(--font-display);
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--text-muted);
  }
  .turn.assistant .role { color: var(--agent-accent); }
  .turn.error .role { color: var(--error); }
  .text { font-size: 13.5px; line-height: 1.5; color: var(--text-secondary); white-space: pre-wrap; word-wrap: break-word; }
  .turn.user .text { color: var(--text-primary); }
  .turn.error .text { color: var(--error); }

  .t-inputrow { display: flex; gap: 8px; padding-top: 10px; flex-shrink: 0; }
  .t-input {
    flex: 1;
    padding: 8px 12px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-bottom: 2px solid var(--text-muted);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 13px;
  }
  .t-input:focus { outline: none; border-bottom-color: var(--accent); }
  .t-send {
    width: 38px;
    background: transparent;
    border: 1px solid var(--accent);
    color: var(--accent);
    cursor: pointer;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
  }
  .t-send:disabled { opacity: 0.4; cursor: default; }

  @media (max-width: 900px) {
    .call-panel { grid-template-columns: 1fr; overflow-y: auto; }
    .transcript { border-left: none; padding-left: 0; border-top: 1px solid var(--border); padding-top: 12px; min-height: 240px; }
    .avatar-wrap { width: 240px; height: 240px; --wave-radius: 88px; }
    .avatar-shell { width: 132px; height: 132px; }
  }
</style>
