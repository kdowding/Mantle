// Visualizer engines — framework-agnostic canvas drawing for the now-playing
// HUD (four click-cyclable modes off the live analyser) and the peaks
// scrubber (static decoded peaks + played-fill + playhead). Port of
// ui/music.js's viz block (the spectrogram mode was dropped in the port);
// NowPlaying.svelte owns the rAF loop and feeds an env per frame.

export type RGB = [number, number, number];

export const VIZ_MODES = ['bars', 'radial', 'scope', 'particles'] as const;
export type VizMode = (typeof VIZ_MODES)[number];
export const VIZ_LABELS: Record<VizMode, string> = {
  bars: 'Spectrum', radial: 'Reactor', scope: 'Oscilloscope', particles: 'Particles',
};

export interface VizEnv {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  teal: RGB;
  purple: RGB;
  amp: number; // eased 0..1 play-state envelope
  t: number;   // frame clock in seconds-ish (frame * 0.016)
  freqData: Uint8Array | null;
  timeData: Uint8Array | null;
  analyser: AnalyserNode | null;
  isPlaying: boolean;
}

const rgba = (c: RGB, a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// mean of a freq-bin range, normalized 0..1
function bandAvg(freq: Uint8Array | null, lo: number, hi: number): number {
  if (!freq) return 0;
  let s = 0, n = 0;
  for (let i = lo; i <= hi && i < freq.length; i++) { s += freq[i]; n++; }
  return n ? s / (n * 255) : 0;
}

// synthetic 0..1 motion when nothing is playing
function idleVal(i: number, t: number): number {
  return Math.max(0, Math.min(1, 0.4 + 0.34 * Math.sin(i * 0.7 + t * 1.6) + 0.26 * Math.sin(i * 1.3 + t * 1.05)));
}

// Log-spaced frequency band → analyser bin range for bar i of barCount.
function barBins(idx: number, barCount: number, binCount: number, sampleRate: number): [number, number] {
  const minF = 30, maxF = 16000, binHz = sampleRate / (binCount * 2);
  const f0 = minF * Math.pow(maxF / minF, idx / barCount);
  const f1 = minF * Math.pow(maxF / minF, (idx + 1) / barCount);
  const b0 = Math.max(0, Math.round(f0 / binHz));
  const b1 = Math.min(binCount - 1, Math.round(f1 / binHz));
  return [b0, Math.max(b0, b1)];
}

export function hexToRgb(hex: string): RGB | null {
  hex = (hex || '').trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(hex) || /^#?([0-9a-f]{3})$/i.exec(hex);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// ── Persistent mode state (survives across frames; reset on mode switch) ────
interface Particle { x: number; y: number; vx: number; vy: number; life: number; hue: RGB; r0: number }
let particles: Particle[] = [];
let bassAvgRun = 0;

// Mode switch wants a clean slate.
export function resetVizTransients(): void {
  particles = [];
}

export function drawViz(mode: VizMode, env: VizEnv): void {
  // Each mode owns its own clear strategy (scope/particles fade for trails;
  // bars/radial hard-clear).
  switch (mode) {
    case 'radial': vizRadial(env); break;
    case 'scope': vizScope(env); break;
    case 'particles': vizParticles(env); break;
    default: vizBars(env);
  }
}

// 1) Spectrum — the ORIGINAL now-playing waveform: faint frequency bars
//    rising from the floor + an overlaid time-domain wave line.
function vizBars({ ctx, w, h, teal, purple, amp, t, freqData, timeData, analyser, isPlaying }: VizEnv): void {
  ctx.clearRect(0, 0, w, h);
  const [tr, tg, tb] = teal, [pr, pg, pb] = purple;
  const barCount = 22, barArea = h * 0.5, floor = h, bw = (w - 8) / barCount;
  const sr = analyser ? analyser.context.sampleRate : 44100;
  for (let i = 0; i < barCount; i++) {
    let raw: number;
    if (analyser && freqData) {
      const [b0, b1] = barBins(i, barCount, analyser.frequencyBinCount, sr);
      let sum = 0;
      for (let b = b0; b <= b1; b++) sum += freqData[b];
      raw = sum / ((b1 - b0 + 1) * 255);
    } else {
      raw = 0.35 + 0.32 * Math.sin(i * 0.7 + t * 1.7) + 0.28 * Math.sin(i * 1.3 + t * 1.1);
      raw = Math.max(0, Math.min(1, raw));
    }
    let bh = raw * barArea * amp;
    if (analyser && isPlaying && amp > 0.3) bh = Math.max(bh, 2);
    const x = 4 + i * bw;
    const accent = (i * 7 + 2) % 5 === 0;
    const g = ctx.createLinearGradient(x, floor - bh, x, floor);
    const [cr, cg, cb] = accent ? [pr, pg, pb] : [tr, tg, tb];
    g.addColorStop(0, `rgba(${cr},${cg},${cb},${(accent ? 0.14 : 0.2) * amp})`);
    g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x, floor - bh, bw - 2, bh);
  }
  const centerY = h * 0.5, maxDev = (isPlaying ? 16 : 5) * amp, pts = 80;
  ctx.beginPath();
  for (let i = 0; i <= pts; i++) {
    const xr = i / pts, xp = xr * w;
    let yo: number;
    if (analyser && timeData) {
      const s = (timeData[Math.floor(xr * (timeData.length - 1))] - 128) / 128;
      yo = s * maxDev;
    } else {
      yo = maxDev * (0.5 * Math.sin(xr * Math.PI * 4 + t * 0.3) + 0.3 * Math.sin(xr * Math.PI * 7.3 + t * 0.17));
    }
    if (i === 0) ctx.moveTo(xp, centerY + yo);
    else ctx.lineTo(xp, centerY + yo);
  }
  ctx.strokeStyle = `rgba(${tr},${tg},${tb},${(isPlaying ? 0.26 : 0.08) * amp})`;
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

// 2) Radial reactor — frequency spokes around a bass-throbbing core.
function vizRadial({ ctx, w, h, teal, purple, amp, t, freqData, analyser }: VizEnv): void {
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const bass = analyser && freqData ? bandAvg(freqData, 1, 6) : 0.4 + 0.3 * Math.sin(t * 2);
  const coreR = Math.min(w, h) * 0.16 * (1 + bass * 0.7) * (0.6 + amp * 0.6);
  const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.2);
  cg.addColorStop(0, rgba(teal, 0.5 * (0.5 + bass)));
  cg.addColorStop(0.5, rgba(teal, 0.12));
  cg.addColorStop(1, rgba(teal, 0));
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.arc(cx, cy, coreR * 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = rgba(teal, 0.8);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
  ctx.stroke();
  const N = 72, innerR = coreR + 4, maxLen = Math.min(w, h) * 0.34;
  const sr = analyser ? analyser.context.sampleRate : 44100;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  for (let i = 0; i < N; i++) {
    let v: number;
    if (analyser && freqData) {
      const [b0, b1] = barBins(i, N, analyser.frequencyBinCount, sr);
      v = Math.pow(bandAvg(freqData, b0, b1), 0.8);
    } else {
      v = idleVal(i, t) * 0.6;
    }
    const len = 4 + v * maxLen * (0.5 + amp), ang = (i / N) * Math.PI * 2 + t * 0.25;
    const c = Math.cos(ang), s = Math.sin(ang), col = i % 6 === 0 ? purple : teal;
    ctx.strokeStyle = rgba(col, 0.22 + v * 0.6);
    ctx.beginPath();
    ctx.moveTo(cx + c * innerR, cy + s * innerR);
    ctx.lineTo(cx + c * (innerR + len), cy + s * (innerR + len));
    ctx.stroke();
  }
}

// 3) Oscilloscope + Lissajous — glowing trace, persistence trails.
function vizScope({ ctx, w, h, teal, purple, amp, t, timeData }: VizEnv): void {
  ctx.fillStyle = 'rgba(8,8,14,0.22)'; // trail fade
  ctx.fillRect(0, 0, w, h);
  const cy = h / 2, len = timeData ? timeData.length : 256;
  ctx.shadowBlur = 8;
  ctx.shadowColor = rgba(teal, 0.8);
  ctx.beginPath();
  for (let i = 0; i <= len; i++) {
    const xr = i / len, x = xr * w;
    const s = timeData ? (timeData[i % len] - 128) / 128 : 0.4 * Math.sin(xr * Math.PI * 6 + t * 2);
    const y = cy + s * h * 0.42 * (0.4 + amp);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = rgba(teal, 0.85);
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();
  if (timeData) { // Lissajous: sample[i] vs sample[i+¼] → loops on sustained tones
    const cx = w / 2, R = Math.min(w, h) * 0.32, off = (len / 4) | 0;
    ctx.beginPath();
    for (let i = 0; i < len; i++) {
      const sx = (timeData[i] - 128) / 128, sy = (timeData[(i + off) % len] - 128) / 128;
      const x = cx + sx * R, y = cy + sy * R;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = rgba(purple, 0.4 + amp * 0.3);
    ctx.lineWidth = 1.4;
    ctx.shadowColor = rgba(purple, 0.7);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
}

// 4) Particle / starfield burst — driven by the audio: spawn rate tracks
//    loudness (silence → empty), bass spikes fire fast bursts + a center
//    bloom, and outward speed scales with level. Idle = a sparse drift.
function vizParticles({ ctx, w, h, teal, purple, freqData, analyser, isPlaying }: VizEnv): void {
  ctx.fillStyle = 'rgba(8,8,14,0.30)'; // trail fade
  ctx.fillRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const playing = isPlaying && !!analyser && !!freqData;
  const bass = playing ? bandAvg(freqData, 1, 8) : 0;
  const energy = playing ? bandAvg(freqData, 0, freqData!.length - 1) : 0;
  // beat = bass spiking above its short-term running average
  bassAvgRun = bassAvgRun * 0.9 + bass * 0.1;
  const beat = playing && bass > bassAvgRun * 1.25 && bass > 0.2;
  // spawn count ramps hard with loudness (quiet → ~none); beats add a burst
  const steady = playing ? Math.round(energy * energy * 70) : (Math.random() < 0.15 ? 1 : 0);
  const spawn = steady + (beat ? 20 + Math.round(bass * 34) : 0);
  const kick = beat ? 2.4 : 1; // beats fling particles outward faster
  for (let k = 0; k < spawn && particles.length < 340; k++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = (playing ? 0.5 + Math.random() * (1 + energy * 8) : 0.25 + Math.random() * 0.5) * kick;
    particles.push({ x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 1, hue: Math.random() < 0.3 ? purple : teal, r0: 1 + energy * 3.5 });
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy; p.vx *= 1.012; p.vy *= 1.012; p.life -= 0.012;
    if (p.life <= 0 || p.x < -6 || p.x > w + 6 || p.y < -6 || p.y > h + 6) { particles.splice(i, 1); continue; }
    ctx.fillStyle = rgba(p.hue, p.life * 0.9);
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r0 * p.life + 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  // central core pulses with bass; a brighter bloom flashes on beats
  const bloomR = Math.max(8, (2 + bass * 16) * (beat ? 6 : 3));
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, bloomR);
  g.addColorStop(0, rgba(teal, (beat ? 0.55 : 0.22) * (0.4 + bass)));
  g.addColorStop(1, rgba(teal, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

// ── Peaks scrubber ───────────────────────────────────────────────────────────

// SoundCloud-style waveform seekbar: decoded peak bars, played-fill in the
// accent color, a playhead line. `peaks` null = faint baseline placeholder
// while the decode is in flight.
export function drawScrubber(
  sctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  peaks: number[] | null,
  progressRatio: number,
  accent: RGB,
): void {
  const mid = h / 2;
  sctx.clearRect(0, 0, w, h);
  const playedX = w * progressRatio;
  if (!peaks) {
    sctx.fillStyle = 'rgba(255,255,255,0.07)';
    sctx.fillRect(0, mid - 1, w, 2);
    sctx.fillStyle = rgba(accent, 0.5);
    sctx.fillRect(0, mid - 1, playedX, 2);
    return;
  }
  const N = peaks.length, bw = w / N, gap = bw > 3 ? 1 : 0;
  for (let i = 0; i < N; i++) {
    const x = i * bw, bh = Math.max(1, peaks[i] * (h - 2));
    sctx.fillStyle = x < playedX ? rgba(accent, 0.95) : 'rgba(255,255,255,0.16)';
    sctx.fillRect(x, mid - bh / 2, Math.max(1, bw - gap), bh);
  }
  sctx.fillStyle = rgba(accent, 1);
  sctx.fillRect(Math.min(w - 1.5, playedX), 0, 1.5, h);
}

// Reduce a decoded track to ~n normalized peak bars (power-curved for shape).
export function computePeaks(audioBuffer: AudioBuffer, n: number): number[] {
  const ch = audioBuffer.getChannelData(0);
  const block = Math.floor(ch.length / n) || 1;
  const peaks = Array.from({ length: n }, () => 0);
  let max = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    const start = i * block, end = Math.min(ch.length, start + block);
    for (let j = start; j < end; j++) {
      const a = Math.abs(ch[j]);
      if (a > m) m = a;
    }
    peaks[i] = m;
    if (m > max) max = m;
  }
  if (max > 0) for (let i = 0; i < n; i++) peaks[i] = Math.pow(peaks[i] / max, 0.85);
  return peaks;
}
