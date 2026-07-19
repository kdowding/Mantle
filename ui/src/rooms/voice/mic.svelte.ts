// Mic — voice-input pipeline (browser-side Silero VAD + sidecar Whisper).
// The Svelte port of ui/mic.js.
//
// INDEPENDENT of the TTS-out toggle (never unify them). The two coordinate
// for exactly one rule: while agent audio is playing, the mic pauses so the
// agent's voice can't trip our own VAD — echo cancellation alone isn't
// enough; speakers → mic bleed-through happens at any volume. The voice
// engine notifies turn start/end through setTtsLifecycle.
//
// Pipeline per utterance:
//   getUserMedia (echo cancel + noise suppression + AGC)
//     → @ricky0123/vad-web Silero VAD (CDN-loaded on first toggle-on)
//       → onSpeechEnd: Float32Array @16kHz
//         → encodeWav → POST /api/voice/transcribe
//           → {text} → sendChat(text)  (the full normal send path)
import { sendChat } from '../../lib/ws';
import { setTtsLifecycle } from './voice.svelte';
import { encodeWav } from './wav';

// ── Configurable VAD endpointing (the "feel" knobs) ──────────────────────────
// Silero v5 frames are 32ms @ 16kHz (frameSamples=512, overriding the lib's
// 1536/96ms default for finer endpointing granularity):
//   redemptionFrames 36 × 32ms ≈ 1150ms silence-after-speech threshold —
//     generous for natural thinking pauses while staying responsive
//   preSpeechPadFrames 10 ≈ 320ms pre-roll before speech onset
//   minSpeechFrames 8 ≈ 256ms shortest accepted utterance (drops coughs)
const VAD_OPTS = {
  model: 'v5',
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  redemptionFrames: 36,
  preSpeechPadFrames: 10,
  minSpeechFrames: 8,
  frameSamples: 512,
};

// Whisper hallucination phrases. The server-side segment filter catches most
// silence-on-mic artifacts; these specific phrases survive any threshold
// tuning (Whisper learned them from YouTube captions + Zoom audio).
const HALLUCINATION_PHRASES = new Set([
  'thank you', 'thanks', 'thanks for watching',
  'thank you for watching', 'thank you for listening',
  'bye', 'bye-bye', 'goodbye',
  'you', 'yeah', 'okay', 'ok',
  '.', '..', '...', '!', '?', '♪',
  'subtitles by the amara.org community',
  '[music]', '(music)', 'music',
  '[applause]', '(applause)',
]);

function isLikelyHallucination(text: string): boolean {
  const norm = text.toLowerCase().replace(/^[\s.!?,]+|[\s.!?,]+$/g, '').trim();
  if (!norm) return true;
  return HALLUCINATION_PHRASES.has(norm);
}

// CDN-pinned versions. The PAIR matters — vad-web 0.0.29 was built against
// onnxruntime-web 1.22.0; mismatched ORT WASM bundles 404 on the dynamic
// import of ort-wasm-simd-threaded.mjs. Bump both together or neither.
const VAD_VERSION = '0.0.29';
const ORT_VERSION = '1.22.0';
const VAD_BASE = `https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@${VAD_VERSION}/dist/`;
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const VAD_LIB_URL = `${VAD_BASE}bundle.min.js`;
const ORT_LIB_URL = `${ORT_BASE}ort.wasm.min.js`; // WASM-only build, matches vad-web
const STT_LOAD_TIMEOUT_MS = 120_000;

// Tail-end coverage after TTS playback: onended fires at the sample boundary
// but ~20-100ms is still draining the speakers, Chrome's AEC doesn't cover
// AudioContext output, and Silero needs ~100ms after start() before scoring.
// Without this, the agent's last syllable comes back as user input.
const MIC_RESUME_COOLDOWN_MS = 500;

export type MicState = 'idle' | 'loading' | 'listening' | 'capturing' | 'transcribing' | 'paused' | 'failed';

export const mic = $state({
  state: 'idle' as MicState,
});

export const MIC_TITLES: Record<MicState, string> = {
  idle: 'Mic off - click to enable voice input',
  loading: 'Loading Whisper + Silero VAD…',
  listening: 'Listening - speak to send',
  capturing: 'Capturing your speech…',
  transcribing: 'Transcribing…',
  paused: 'Paused - waiting for the agent to finish speaking',
  failed: 'Mic failed - see console; click to retry',
};

// ── VAD library globals (CDN bundle) ─────────────────────────────────────────
interface MicVADInstance {
  start(): void;
  pause(): void;
  destroy?(): void;
}
// `new` is a static factory method on MicVAD (not a constructor) — Record
// sidesteps TS parsing `new(...)` as a construct signature.
type MicVADFactory = Record<'new', (options: Record<string, unknown>) => Promise<MicVADInstance>>;

declare global {
  interface Window {
    vad?: { MicVAD: MicVADFactory };
    MicVAD?: MicVADFactory;
  }
}

// ── Module state ─────────────────────────────────────────────────────────────
let myvad: MicVADInstance | null = null;
let inflightTranscribe: AbortController | null = null;
let micPausedByTts = false; // true while TTS audio is mid-playback
let vadLibLoaded = false;
// Refcount of in-flight TTS turns (replay-during-stream / back-to-back turns
// overlap); resume only when ALL have ended, after the cooldown.
let activeTtsTurns = 0;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;

// ── Lazy CDN load ────────────────────────────────────────────────────────────
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.async = false; // preserve order: ort before the vad bundle
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function ensureVadLib(): Promise<boolean> {
  if (vadLibLoaded && window.vad?.MicVAD) return true;
  try {
    await loadScript(ORT_LIB_URL);
    await loadScript(VAD_LIB_URL);
    // Some bundle versions expose window.vad, others a global MicVAD.
    if (!window.vad?.MicVAD && typeof window.MicVAD !== 'undefined') {
      window.vad = { MicVAD: window.MicVAD };
    }
    vadLibLoaded = !!window.vad?.MicVAD;
    return vadLibLoaded;
  } catch (err) {
    console.error('[mic] failed to load Silero VAD library from CDN', err);
    return false;
  }
}

// ── Sidecar: Whisper must be loaded before we start capturing ────────────────
async function ensureSttLoaded(): Promise<boolean> {
  try {
    const r = await fetch('/api/voice/status');
    if (!r.ok) return false;
    const status = (await r.json()) as { stt?: string };
    if (status.stt === 'loaded') return true;
    // STT-only load — tts:false leaves the TTS toggle's model alone.
    await fetch('/api/voice/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tts: false, stt: true }),
    });
    const deadline = Date.now() + STT_LOAD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 700));
      const s = await fetch('/api/voice/status').then((x) => x.json() as Promise<{ stt?: string }>).catch(() => null);
      if (!s) return false;
      if (s.stt === 'loaded') return true;
      if (s.stt === 'failed') return false;
    }
    return false;
  } catch (err) {
    console.error('[mic] STT load orchestration failed', err);
    return false;
  }
}

// ── VAD lifecycle ────────────────────────────────────────────────────────────
async function startVad(): Promise<void> {
  mic.state = 'loading';

  if (!(await ensureVadLib())) { mic.state = 'failed'; return; }
  if (!(await ensureSttLoaded())) { mic.state = 'failed'; return; }

  try {
    myvad = await window.vad!.MicVAD.new({
      ...VAD_OPTS,
      // Pin asset paths to the script-tag versions — vad-web defaults to
      // @latest for its model and @1.14.0 for ORT WASM; both 404 today.
      baseAssetPath: VAD_BASE,
      onnxWASMBasePath: ORT_BASE,
      // Chrome's WebRTC echo cancellation + noise suppression + AGC — the
      // same primitives Meet/Teams use.
      additionalAudioConstraints: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      onSpeechStart: () => {
        if (mic.state === 'listening') mic.state = 'capturing';
      },
      onVADMisfire: () => {
        // Speech below minSpeechFrames — drop and resume listening.
        if (mic.state === 'capturing') mic.state = micPausedByTts ? 'paused' : 'listening';
      },
      onSpeechEnd: (audio: Float32Array) => {
        void handleSpeechEnd(audio);
      },
    });
    myvad.start();
    // TTS started playing while we warmed up → pause immediately.
    if (micPausedByTts) {
      try { myvad.pause(); } catch { /* ignore */ }
      mic.state = 'paused';
    } else {
      mic.state = 'listening';
    }
  } catch (err) {
    console.error('[mic] MicVAD setup failed', err);
    mic.state = 'failed';
  }
}

function stopVad(): void {
  if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
  activeTtsTurns = 0;
  if (myvad) {
    try { myvad.pause(); } catch { /* ignore */ }
    try { myvad.destroy?.(); } catch { /* ignore */ }
    myvad = null;
  }
  if (inflightTranscribe) {
    try { inflightTranscribe.abort(); } catch { /* ignore */ }
    inflightTranscribe = null;
  }
  mic.state = 'idle';
  // Free Whisper's VRAM, mirroring the TTS toggle (tts:false leaves TTS
  // alone — independent). Only a real toggle-off lands here; the TTS-pause
  // path uses paused/listening, so STT stays warm there.
  fetch('/api/voice/unload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tts: false, stt: true }),
  }).catch(() => {});
}

// ── Transcribe + auto-send ───────────────────────────────────────────────────
async function handleSpeechEnd(audioFloat32: Float32Array): Promise<void> {
  if (mic.state === 'idle' || mic.state === 'failed') return;
  mic.state = 'transcribing';

  const wav = encodeWav(audioFloat32, 16000);
  const ac = new AbortController();
  inflightTranscribe = ac;

  try {
    // language=en skips Whisper's auto-detect (~50-100ms per utterance).
    // Single-locale for now; plumb a config knob if that changes.
    const r = await fetch('/api/voice/transcribe?language=en', {
      method: 'POST',
      body: new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const errBody = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(errBody.error || `${r.status} ${r.statusText}`);
    }
    const data = (await r.json()) as { text?: string };
    const text = (data.text ?? '').trim();
    // Empty = sub-noise mic or every segment filtered server-side; a known
    // hallucination phrase would start an agent turn the user never asked
    // for. Both drop silently and keep listening.
    if (!text) return;
    if (isLikelyHallucination(text)) {
      console.debug('[mic] dropped likely hallucination:', text);
      return;
    }
    // The full normal send path — lazy session creation, attachments, the
    // voiceMode turn decorator — applies to spoken input too.
    void sendChat(text);
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return; // toggled off mid-flight
    console.error('[mic] transcribe failed', err);
  } finally {
    inflightTranscribe = null;
    if (mic.state === 'transcribing') {
      mic.state = micPausedByTts ? 'paused' : 'listening';
    }
  }
}

// ── Mic ↔ TTS coordination (hooks called by voice.svelte.ts) ────────────────
function onTtsTurnStart(): void {
  activeTtsTurns++;
  // Cancel any pending resume so we don't un-pause mid-agent-speech.
  if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
  micPausedByTts = true;
  if (myvad && (mic.state === 'listening' || mic.state === 'capturing')) {
    try { myvad.pause(); } catch { /* ignore */ }
    mic.state = 'paused';
  }
}

function onTtsTurnEnd(): void {
  activeTtsTurns = Math.max(0, activeTtsTurns - 1);
  if (activeTtsTurns > 0) return; // another turn's audio still playing
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    if (activeTtsTurns > 0) return; // a fresh turn started during cooldown
    micPausedByTts = false;
    if (myvad && mic.state === 'paused') {
      try { myvad.start(); } catch (err) { console.warn('[mic] resume after TTS failed', err); }
      mic.state = 'listening';
    }
  }, MIC_RESUME_COOLDOWN_MS);
}

// ── Toggle + registration ────────────────────────────────────────────────────
export function toggleMic(): void {
  if (mic.state === 'loading' || mic.state === 'transcribing') return;
  if (mic.state === 'idle' || mic.state === 'failed') void startVad();
  else stopVad();
}

let registered = false;

export function registerMic(): void {
  if (registered) return;
  registered = true;
  setTtsLifecycle({ onTurnStart: onTtsTurnStart, onTurnEnd: onTtsTurnEnd });
}
