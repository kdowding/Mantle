// Call room — realtime voice calls (xAI Grok Voice Agent via the server's
// /ws proxy). The Svelte port of ui/realtime.js: mic capture through an
// AudioWorklet (downsample → 24kHz Int16 PCM → base64 call_audio frames),
// gapless playback on a rolling nextStartTime, analyser-driven avatar
// amplitude, timer + $0.05/min cost meter, transcript turns, typed input,
// and the resume flow over an existing call-mode session.
import { ui } from '../../lib/state.svelte';
import { onWsEvent, sendWs, type WsEvent } from '../../lib/ws';
import { personas } from '../../lib/personas.svelte';
import { createSession, getTranscript } from '../../lib/api';
import { loadSessions } from '../../lib/sessions';
import { lsGet, lsSet } from '../../lib/storage';

const LS_CALL_VOICE = 'mantle-call-voice'; // same key as the vanilla UI
export const COST_PER_MIN = 0.05; // xAI realtime pricing — the overlay's meter

export type CallStatus = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'disconnected';

export interface CallTurn {
  id: string;
  kind: 'user' | 'assistant' | 'error';
  text: string;
}

export const call = $state({
  active: false,
  status: 'connecting' as CallStatus,
  statusText: 'Connecting...',
  muted: false,
  startedAt: 0,
  maxDurationMs: 0,
  voice: (lsGet(LS_CALL_VOICE) || 'ara'),
  turns: [] as CallTurn[],
  draft: '', // typed mid-call input
});

export const CALL_VOICES = ['ara', 'eve', 'rex', 'sal', 'leo'];

export function setCallVoice(v: string): void {
  call.voice = v;
  lsSet(LS_CALL_VOICE, v);
}

// ── Non-reactive call/audio internals ────────────────────────────────────────
let callId: string | null = null;
let sessionId: string | null = null;

let micStream: MediaStream | null = null;
let micCtx: AudioContext | null = null;
let workletNode: AudioWorkletNode | null = null;
let micAnalyser: AnalyserNode | null = null;

let playbackCtx: AudioContext | null = null;
let playbackGain: GainNode | null = null;
let playbackAnalyser: AnalyserNode | null = null;
let playbackNextTime = 0;
const activeSources = new Set<AudioBufferSourceNode>();
let assistantSpeechActive = false;
let waitingForPlaybackDrain = false;

// The open assistant turn deltas accumulate into (index into call.turns).
let assistantTurnIdx: number | null = null;

function setStatus(status: CallStatus, text: string): void {
  call.status = status;
  call.statusText = text;
}

// ── Start / stop ─────────────────────────────────────────────────────────────

// Fresh call: POST a call-mode session first (the server pre-registers the
// isCall meta row the call_start handler looks up). Resume: reuse the
// session id — the server prefills the xAI conversation from its JSONL; we
// prefill the visible transcript from the same rows.
export async function startCall(opts: { resumeSessionId?: string; resumeVoice?: string } = {}): Promise<void> {
  if (call.active) return;
  const agentId = ui.currentAgentId;
  if (!agentId) return;
  ensureRegistered();

  const voice = opts.resumeVoice ?? call.voice;
  sessionId = opts.resumeSessionId ?? null;

  if (!sessionId) {
    try {
      const { id } = await createSession(agentId, { mode: 'call', callVoice: voice });
      sessionId = id;
    } catch (e) {
      console.error('[call] failed to create call session', e);
      return;
    }
  }

  callId = null;
  assistantTurnIdx = null;
  call.turns = [];
  call.muted = false;
  call.draft = '';
  call.startedAt = 0;
  call.active = true;
  setStatus('connecting', 'Connecting...');

  if (opts.resumeSessionId) {
    try {
      const rows = await getTranscript(opts.resumeSessionId);
      for (const m of rows ?? []) {
        const text = (m.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('\n')
          .trim();
        if (!text) continue;
        if (m.role === 'user' || m.role === 'assistant') {
          call.turns.push({ id: crypto.randomUUID(), kind: m.role, text });
        }
      }
    } catch {
      // best effort — proceed without the visible prefill
    }
  }

  const payload: Record<string, unknown> = { type: 'call_start', agentId, sessionId, voice };
  // Same persona mask the chat UI would apply; locked at call start.
  if (personas.current) payload.persona = personas.current;
  try {
    await sendWs(payload);
  } catch {
    setStatus('disconnected', 'Failed to connect');
    window.setTimeout(() => void endCall(true), 1500);
  }
}

export async function endCall(skipServerEnd = false): Promise<void> {
  if (!call.active) return;
  if (callId && !skipServerEnd) {
    sendWs({ type: 'call_end', callId }).catch(() => {});
  }

  // Mic teardown
  try { workletNode?.disconnect(); } catch { /* ignore */ }
  workletNode = null;
  if (micStream) for (const t of micStream.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
  micStream = null;
  micAnalyser = null;
  if (micCtx) { try { await micCtx.close(); } catch { /* ignore */ } }
  micCtx = null;

  // Playback teardown
  for (const src of activeSources) { try { src.stop(); } catch { /* ignore */ } }
  activeSources.clear();
  playbackAnalyser = null;
  playbackGain = null;
  if (playbackCtx) { try { await playbackCtx.close(); } catch { /* ignore */ } }
  playbackCtx = null;
  playbackNextTime = 0;
  assistantSpeechActive = false;
  waitingForPlaybackDrain = false;

  callId = null;
  sessionId = null;
  call.active = false;
  void loadSessions(); // surface the just-ended call session in the sidebar
}

export function toggleMute(): void {
  call.muted = !call.muted;
}

// Typed mid-call input: append locally (no STT round-trip for typed text),
// send call_text — the reply arrives via the same audio/transcript events.
export function sendCallText(): void {
  const text = call.draft.trim();
  if (!text || !callId) return;
  appendUserTurn(text);
  sendWs({ type: 'call_text', callId, text }).catch(() => {});
  call.draft = '';
}

// ── Inbound events (claimed on the ws room seam) ─────────────────────────────

interface CallEvent extends WsEvent {
  callId?: string;
  startedAt?: number;
  maxDurationMs?: number;
  audio?: string;
  who?: string;
  state?: string;
}

function handleCallEvent(raw: WsEvent): void {
  if (!call.active) return;
  const ev = raw as CallEvent;
  if (ev.callId && callId && ev.callId !== callId) return;

  switch (ev.type) {
    case 'call_started':
      callId = ev.callId ?? null;
      call.startedAt = ev.startedAt ?? Date.now();
      call.maxDurationMs = ev.maxDurationMs ?? 3600000;
      setStatus('listening', 'Listening...');
      void startMic();
      return;
    case 'call_audio':
      playAudio(ev.audio ?? '');
      return;
    case 'call_user_transcript':
      appendUserTurn(ev.text ?? '');
      return;
    case 'call_assistant_transcript_delta':
      appendAssistantDelta(ev.text ?? '');
      return;
    case 'call_assistant_transcript_done':
      finalizeAssistantTurn(ev.text ?? '');
      return;
    case 'call_speaking_state':
      handleSpeakingState(ev.who ?? '', ev.state ?? '');
      return;
    case 'call_error':
      call.turns.push({ id: crypto.randomUUID(), kind: 'error', text: ev.error ?? 'unknown error' });
      return;
    case 'call_closed': {
      const reason = ev.reason ?? 'server';
      const label =
        reason === 'timeout' ? 'Call ended (max duration reached)'
          : reason === 'error' ? 'Call ended due to error'
            : 'Call ended';
      setStatus('disconnected', label);
      // Brief delay so the label is readable before the overlay closes.
      window.setTimeout(() => void endCall(true), 1800);
      return;
    }
    default:
      return;
  }
}

// ── Transcript turns ─────────────────────────────────────────────────────────

function appendUserTurn(text: string): void {
  if (!text) return;
  call.turns.push({ id: crypto.randomUUID(), kind: 'user', text });
  assistantTurnIdx = null; // next delta opens a fresh assistant turn
}

function appendAssistantDelta(text: string): void {
  if (assistantTurnIdx == null) {
    call.turns.push({ id: crypto.randomUUID(), kind: 'assistant', text: '' });
    assistantTurnIdx = call.turns.length - 1;
  }
  call.turns[assistantTurnIdx].text += text;
}

function finalizeAssistantTurn(fullText: string): void {
  if (assistantTurnIdx != null) {
    // The server's final text is canonical — replace accumulated deltas.
    call.turns[assistantTurnIdx].text = fullText;
    assistantTurnIdx = null;
  } else if (fullText.trim()) {
    // text.done with no deltas (text-mode response, no audio generated).
    call.turns.push({ id: crypto.randomUUID(), kind: 'assistant', text: fullText });
  }
}

// ── Speaking state → UI status ───────────────────────────────────────────────

function handleSpeakingState(who: string, st: string): void {
  if (who === 'user' && st === 'start') {
    // Barge-in: xAI cancels the response server-side; kill local playback
    // immediately so the user doesn't keep hearing the stale reply.
    flushPlayback();
    setStatus('listening', 'Listening...');
  } else if (who === 'user' && st === 'end') {
    setStatus('thinking', 'Thinking...');
  } else if (who === 'assistant' && st === 'start') {
    assistantSpeechActive = true;
    waitingForPlaybackDrain = false;
    setStatus('speaking', 'Speaking...');
  } else if (who === 'assistant' && st === 'end') {
    assistantSpeechActive = false;
    waitForPlaybackThenListen();
  }
}

// ── Mic capture ──────────────────────────────────────────────────────────────

async function startMic(): Promise<void> {
  if (!call.active) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        // Hint only — the worklet does the real downsampling to 24kHz.
        sampleRate: 24000,
      },
    });
  } catch (e) {
    setStatus('disconnected', `Mic access denied: ${e instanceof Error ? e.message : e}`);
    call.turns.push({ id: crypto.randomUUID(), kind: 'error', text: 'Mic access denied - call cannot continue' });
    window.setTimeout(() => void endCall(), 1500);
    return;
  }

  micCtx = new AudioContext();
  try {
    await micCtx.audioWorklet.addModule('/realtime-worklet.js');
  } catch (e) {
    setStatus('disconnected', `Audio worklet failed: ${e instanceof Error ? e.message : e}`);
    call.turns.push({ id: crypto.randomUUID(), kind: 'error', text: 'Audio worklet failed to load' });
    return;
  }

  const source = micCtx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(micCtx, 'realtime-capture-worklet', {
    processorOptions: {
      targetSampleRate: 24000,
      sourceSampleRate: micCtx.sampleRate,
      frameSize: 960, // 40ms at 24kHz
    },
  });
  micAnalyser = micCtx.createAnalyser();
  // 512 bins ≈ 46Hz/bin at 24kHz — fine enough that consonants flicker.
  micAnalyser.fftSize = 512;
  micAnalyser.smoothingTimeConstant = 0.3;

  source.connect(workletNode);
  source.connect(micAnalyser);
  // The worklet only pulls audio when connected downstream — route through
  // a muted gain so process() runs without monitoring our own mic.
  const sink = micCtx.createGain();
  sink.gain.value = 0;
  workletNode.connect(sink);
  sink.connect(micCtx.destination);

  workletNode.port.onmessage = (e: MessageEvent<Int16Array>) => {
    if (!call.active || !callId || call.muted) return;
    sendWs({ type: 'call_audio', callId, audio: int16ToBase64(e.data) }).catch(() => {});
  };
}

// ── Playback ─────────────────────────────────────────────────────────────────

function ensurePlaybackContext(): void {
  if (playbackCtx) return;
  playbackCtx = new AudioContext();
  playbackGain = playbackCtx.createGain();
  playbackGain.gain.value = 1;
  playbackAnalyser = playbackCtx.createAnalyser();
  playbackAnalyser.fftSize = 512;
  playbackAnalyser.smoothingTimeConstant = 0.3;
  playbackGain.connect(playbackAnalyser);
  playbackAnalyser.connect(playbackCtx.destination);
}

function playAudio(base64: string): void {
  if (!call.active || !base64) return;
  ensurePlaybackContext();
  const ctx = playbackCtx!;

  const int16 = base64ToInt16(base64);
  if (int16.length === 0) return;
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

  const buffer = ctx.createBuffer(1, float32.length, 24000);
  buffer.getChannelData(0).set(float32);

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(playbackGain!);

  const startAt = Math.max(ctx.currentTime, playbackNextTime);
  src.start(startAt);
  playbackNextTime = startAt + buffer.duration;

  activeSources.add(src);
  // Local playback is the authoritative visual signal — response.done can
  // land before the locally scheduled audio has drained the speakers.
  if (!assistantSpeechActive) waitingForPlaybackDrain = true;
  setStatus('speaking', 'Speaking...');
  src.onended = () => {
    activeSources.delete(src);
    maybeFinishPlaybackDrain();
  };
}

function flushPlayback(): void {
  waitingForPlaybackDrain = false;
  assistantSpeechActive = false;
  for (const src of activeSources) { try { src.stop(); } catch { /* ignore */ } }
  activeSources.clear();
  if (playbackCtx) playbackNextTime = playbackCtx.currentTime;
}

const playbackIsActive = (): boolean => activeSources.size > 0;

function waitForPlaybackThenListen(): void {
  if (playbackIsActive()) {
    waitingForPlaybackDrain = true;
    setStatus('speaking', 'Speaking...');
    return;
  }
  waitingForPlaybackDrain = false;
  setStatus('listening', 'Listening...');
}

export function maybeFinishPlaybackDrain(): void {
  if (!waitingForPlaybackDrain || playbackIsActive()) return;
  waitingForPlaybackDrain = false;
  if (call.status === 'speaking') setStatus('listening', 'Listening...');
}

// The analyser the avatar animation should sample for the current state
// (mic while listening, playback while speaking) — null = synthetic pulse.
export function activeAnalyser(): AnalyserNode | null {
  if (call.status === 'speaking' && playbackAnalyser) return playbackAnalyser;
  if (call.status === 'listening' && micAnalyser && !call.muted) return micAnalyser;
  return null;
}

// ── Encoding helpers ─────────────────────────────────────────────────────────

function int16ToBase64(int16: Int16Array): string {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  // String.fromCharCode.apply has a stack arg limit; chunk to stay safe.
  let s = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(s);
}

function base64ToInt16(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // PCM is LE 16-bit; slice any odd trailing byte (defensive).
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

// ── Registration ─────────────────────────────────────────────────────────────

let registered = false;

function ensureRegistered(): void {
  if (registered) return;
  registered = true;
  onWsEvent('call_', handleCallEvent);
}
