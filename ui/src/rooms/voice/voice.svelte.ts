// Voice room — TTS-out. The Svelte port of ui/voice.js + app.js's
// wireVoiceTextReveal. Two backends behind one playback engine:
//   chatterbox — python sidecar, model load/unload lifecycle, voice files
//   xAI        — hosted api.x.ai TTS, no load phase, voice catalog
// Toggles are mutually exclusive with each other but INDEPENDENT of mic-in
// (a separate room; never unify them).
//
// Audio engine (ported 1:1 — don't re-derive): per-turn state keyed by the
// server's synthId; chunks decode async + release in idx order; playback is
// sample-accurate (each chunk starts at the previous chunk's audio-clock end,
// no event-loop gap), with a 2-chunk/500ms pre-buffer when the queue is idle
// and pacing gaps only at sentence (250ms) / clause (80ms) boundaries via the
// server-stamped pacingChar.
//
// Text reveal: in a voice turn the room CLAIMS text_delta off the WS seam
// (dropped — the user must not read ahead of the voice) and instead reveals
// each chunk's text paced to its audio duration, written through a part-owned
// reveal island in the live assistant bubble. message_end finalizes the turn
// as usual; the bubble's voiceLive flag keeps the Responding… indicator + the
// retry deferral until the queued audio actually finishes on the speakers.
import { ui, chat, getFeature, type ChatMessage, type TextPart } from '../../lib/state.svelte';
import { onWsEvent, onTurnOptions, sendWs, type WsEvent } from '../../lib/ws';
import { createIsland } from '../../lib/stream';
import { updateAgent } from '../../lib/api';
import { lsGet, lsSet } from '../../lib/storage';

const LS_CB_INTENT = 'mantle-voice-toggle'; // same keys as the vanilla UI
const LS_XAI_INTENT = 'mantle-xai-voice-toggle';

const PREBUFFER_CHUNKS = 2;
const PREBUFFER_TIMEOUT_MS = 500;
const PACING_SENTENCE_END_MS = 250;
const PACING_MID_SENTENCE_MS = 80;
const REVEAL_TICK_MS = 16; // voice chunk reveal tick (paced to audio)

export type ChatterboxState = 'unavailable' | 'off' | 'loading' | 'on' | 'failed';
export type XaiState = 'unavailable' | 'off' | 'on';

// ── Reactive room state (what the chrome renders) ───────────────────────────
export const voice = $state({
  cb: 'unavailable' as ChatterboxState,
  xai: 'unavailable' as XaiState,
  sidecarReady: false,
  ttsLoaded: false, // server-side model state, independent of the toggle
  xaiAvailable: false,
  // Voice-file selector (chatterbox): all voices/*.wav + the active agent's
  // resolved selection (explicit override, else <agent-id>.wav if it exists).
  availableVoices: [] as string[],
  selectedVoice: null as string | null,
  // xAI voice catalog + the active agent's pick.
  xaiVoiceCatalog: ['ara', 'eve', 'rex', 'sal', 'leo'] as string[],
  defaultXaiVoice: 'ara',
  selectedXaiVoice: 'ara',
  tuneOpen: false,
});

// Per-agent maps (module-level; reactive projections above are per active agent).
let voicesByAgent: Record<string, boolean> = {};
let selectedVoicesMap: Record<string, string | null> = {};
let xaiVoicesByAgent: Record<string, string | null> = {};

// ── Mic coordination seam ────────────────────────────────────────────────────
// The mic half registers here so agent audio pauses the VAD (speakers → mic
// bleed-through; see mic.svelte.ts). Every tts_start that creates a turn
// produces exactly one onTurnEnd when its audio finishes (or is purged).
interface TtsLifecycle {
  onTurnStart: () => void;
  onTurnEnd: () => void;
}
let ttsLifecycle: TtsLifecycle | null = null;
export function setTtsLifecycle(hooks: TtsLifecycle | null): void {
  ttsLifecycle = hooks;
}

// ── Audio playback engine (ported from ui/voice.js) ─────────────────────────

interface ChunkItem {
  buffer: AudioBuffer | null; // null = error/decode-failed placeholder
  idx: number;
  text: string;
  pacingChar?: string;
  error?: string;
}

interface PlayItem {
  buffer: AudioBuffer;
  synthId: string;
  idx: number;
  text: string;
  pacingChar?: string;
  onStart?: () => void;
  onEnd?: () => void;
}

interface ChunkTiming {
  wsReceivedMs?: number;
  decodeMs?: number;
  playStartMs?: number;
  playEndMs?: number;
}

interface VoiceTurn {
  synthId: string;
  replayId?: string;
  pendingChunks: Map<number, ChunkItem>;
  nextExpectedIdx: number;
  inflightDecodes: Set<Promise<void>>;
  doneSignaled: boolean;
  chunksScheduled: number;
  chunksPlayed: number;
  playbackCompleteFired: boolean;
  onChunkReveal: ((item: ChunkItem) => void) | null;
  onChunkEnd: ((item: ChunkItem) => void) | null;
  onPlaybackComplete: (() => void) | null;
  receivedAt: number;
  chunkTiming: Map<number, ChunkTiming>;
}

// Scheduled source with our turn tag + onStart timer riding along.
type TaggedSource = AudioBufferSourceNode & {
  _mantleSynthId?: string;
  _mantleOnStartTimer?: ReturnType<typeof setTimeout>;
};

const turns = new Map<string, VoiceTurn>();
// Turns purged by reset/toggle-off/replay-stop — late chunks for these must
// not respawn the audio (the vanilla UI had this ghost-audio hole; cheap to
// close). Insertion-ordered Set + cap keeps it from growing unbounded.
const purgedSynthIds = new Set<string>();

function markPurged(synthId: string): void {
  purgedSynthIds.add(synthId);
  if (purgedSynthIds.size > 64) {
    const oldest = purgedSynthIds.values().next().value;
    if (oldest) purgedSynthIds.delete(oldest);
  }
}

let audioCtx: AudioContext | null = null;
let lastScheduledEnd = 0;
let lastScheduledPacingChar = '';
const scheduledSources = new Set<TaggedSource>();
const pendingOnStartTimers = new Set<ReturnType<typeof setTimeout>>();

let pendingPlay: PlayItem[] = [];
let bufferingActive = false;
let bufferingTimer: ReturnType<typeof setTimeout> | null = null;

function ensureAudioContext(): AudioContext {
  audioCtx ??= new AudioContext();
  return audioCtx;
}

function lastSignificantChar(text: string): string {
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ' ' || ch === '\n' || ch === '\t') continue;
    if (ch === '"' || ch === "'" || ch === ')' || ch === '”' || ch === '’') continue;
    return ch;
  }
  return '';
}

function createTurn(synthId: string): VoiceTurn {
  const turn: VoiceTurn = {
    synthId,
    pendingChunks: new Map(),
    nextExpectedIdx: 0,
    inflightDecodes: new Set(),
    doneSignaled: false,
    chunksScheduled: 0,
    chunksPlayed: 0,
    playbackCompleteFired: false,
    onChunkReveal: null,
    onChunkEnd: null,
    onPlaybackComplete: null,
    receivedAt: performance.now(),
    chunkTiming: new Map(),
  };
  turns.set(synthId, turn);
  return turn;
}

function getOrCreateTurn(synthId: string | undefined): VoiceTurn | null {
  if (!synthId || purgedSynthIds.has(synthId)) return null;
  return turns.get(synthId) ?? createTurn(synthId);
}

function ensureChunkTiming(turn: VoiceTurn, idx: number): ChunkTiming {
  let t = turn.chunkTiming.get(idx);
  if (!t) {
    t = {};
    turn.chunkTiming.set(idx, t);
  }
  return t;
}

// All four playback phases observed → ship the per-chunk timing back so the
// server's turn log gets the audio-vs-text gap analysis.
function shipPlaybackReport(turn: VoiceTurn): void {
  if (!turn.chunkTiming.size) return;
  const reports: Array<Record<string, number>> = [];
  for (const [idx, t] of turn.chunkTiming) {
    if (t.wsReceivedMs == null || t.decodeMs == null || t.playStartMs == null || t.playEndMs == null) continue;
    reports.push({
      chunkIdx: idx,
      wsReceivedMs: Math.round(t.wsReceivedMs),
      decodeMs: Math.round(t.decodeMs),
      playStartMs: Math.round(t.playStartMs),
      playEndMs: Math.round(t.playEndMs),
    });
  }
  if (!reports.length) return;
  reports.sort((a, b) => a.chunkIdx - b.chunkIdx);
  sendWs({ type: 'tts_playback_report', synthId: turn.synthId, playbackChunks: reports }).catch(() => {});
}

// doneSignaled + decodes settled + queue drained + every scheduled chunk has
// actually FINISHED on the speakers ⇒ the turn's audio is over.
function maybePlaybackComplete(turn: VoiceTurn): void {
  if (turn.playbackCompleteFired) return;
  if (!turn.doneSignaled) return;
  if (turn.inflightDecodes.size > 0) return;
  if (turn.pendingChunks.size > 0) return;
  if (turn.chunksScheduled !== turn.chunksPlayed) return;
  turn.playbackCompleteFired = true;
  shipPlaybackReport(turn);
  try { turn.onPlaybackComplete?.(); } catch (err) { console.warn('[voice] onPlaybackComplete failed', err); }
  ttsLifecycle?.onTurnEnd();
}

function maybeDisposeTurn(turn: VoiceTurn): void {
  if (!turn.doneSignaled) return;
  if (turn.inflightDecodes.size > 0) return;
  if (turn.pendingChunks.size > 0) return;
  if (turn.chunksScheduled !== turn.chunksPlayed) return;
  maybePlaybackComplete(turn);
  turns.delete(turn.synthId);
  // NOTE: the synthId stays in purgedSynthIds (if there) — late chunks for a
  // purged turn must keep bouncing; the set's cap handles cleanup.
}

async function decodeBase64Wav(b64: string): Promise<AudioBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return ensureAudioContext().decodeAudioData(bytes.buffer);
}

// Idle queue → pre-buffer a couple chunks (or 500ms) before the first
// schedule so subsequent chunks can chain at known audio-clock times.
function enqueue(item: PlayItem): void {
  const ctx = ensureAudioContext();
  const isIdle = lastScheduledEnd <= ctx.currentTime + 0.05;

  if (isIdle && !bufferingActive) {
    bufferingActive = true;
    pendingPlay = [item];
    bufferingTimer = setTimeout(() => {
      if (bufferingActive && pendingPlay.length > 0) flushBufferedPlay();
    }, PREBUFFER_TIMEOUT_MS);
    return;
  }
  if (bufferingActive) {
    pendingPlay.push(item);
    if (pendingPlay.length >= PREBUFFER_CHUNKS) flushBufferedPlay();
    return;
  }
  scheduleChunk(item);
}

function flushBufferedPlay(): void {
  if (bufferingTimer) { clearTimeout(bufferingTimer); bufferingTimer = null; }
  bufferingActive = false;
  const items = pendingPlay;
  pendingPlay = [];
  for (const item of items) scheduleChunk(item);
}

function scheduleChunk(item: PlayItem): void {
  const ctx = ensureAudioContext();
  if (ctx.state === 'suspended') void ctx.resume();

  // Pacing gap only at a sentence/clause boundary signaled by the PREVIOUS
  // chunk's pacingChar — sub-chunks within a sentence chain gaplessly.
  let pacingMs = 0;
  if (lastScheduledEnd > ctx.currentTime + 0.001) {
    const ch = lastScheduledPacingChar;
    if (ch === '.' || ch === '!' || ch === '?') pacingMs = PACING_SENTENCE_END_MS;
    else if (ch === ',' || ch === ';' || ch === ':') pacingMs = PACING_MID_SENTENCE_MS;
  }

  // Sample-accurate: start exactly when the previous chunk ends. The 20ms
  // safety margin on an idle queue lets the audio thread set the source up.
  const baseTime = Math.max(ctx.currentTime + 0.02, lastScheduledEnd);
  const startTime = baseTime + pacingMs / 1000;

  const src = ctx.createBufferSource() as TaggedSource;
  src.buffer = item.buffer;
  src.connect(ctx.destination);
  src._mantleSynthId = item.synthId;

  lastScheduledEnd = startTime + item.buffer.duration;
  lastScheduledPacingChar = item.pacingChar !== undefined ? item.pacingChar : lastSignificantChar(item.text);

  scheduledSources.add(src);

  const turn = turns.get(item.synthId);

  // Web Audio has no onstart — approximate with a timer anchored to the same
  // audio-clock offset. A few ms of skew is fine for text-reveal pacing.
  const timeUntilStart = Math.max(0, (startTime - ctx.currentTime) * 1000);
  const onStartTimer = setTimeout(() => {
    pendingOnStartTimers.delete(onStartTimer);
    if (turn) {
      const t = turn.chunkTiming.get(item.idx);
      if (t) t.playStartMs = performance.now() - turn.receivedAt;
    }
    try { item.onStart?.(); } catch (err) { console.warn('[voice] onStart cb failed', err); }
  }, timeUntilStart);
  pendingOnStartTimers.add(onStartTimer);
  src._mantleOnStartTimer = onStartTimer;

  src.onended = () => {
    scheduledSources.delete(src);
    if (turn) {
      const t = turn.chunkTiming.get(item.idx);
      if (t) t.playEndMs = performance.now() - turn.receivedAt;
    }
    try { item.onEnd?.(); } catch (err) { console.warn('[voice] onEnd cb failed', err); }
  };

  src.start(startTime);
}

// Release in-order chunks into the playback queue.
function drainTurn(turn: VoiceTurn): void {
  while (turn.pendingChunks.has(turn.nextExpectedIdx)) {
    const item = turn.pendingChunks.get(turn.nextExpectedIdx)!;
    turn.pendingChunks.delete(turn.nextExpectedIdx);
    turn.nextExpectedIdx++;
    if (item.buffer) {
      turn.chunksScheduled++;
      enqueue({
        buffer: item.buffer,
        synthId: turn.synthId,
        idx: item.idx,
        text: item.text,
        pacingChar: item.pacingChar,
        onStart: () => turn.onChunkReveal?.(item),
        onEnd: () => {
          try { turn.onChunkEnd?.(item); } catch (err) { console.warn('[voice] end cb failed', err); }
          turn.chunksPlayed++;
          maybePlaybackComplete(turn);
          maybeDisposeTurn(turn);
        },
      });
    } else {
      // Error chunk — no audio, but the text still reveals (reader sees what
      // was said). Counted scheduled+played so completion accounting balances.
      turn.chunksScheduled++;
      try { turn.onChunkReveal?.(item); } catch (err) { console.warn('[voice] reveal cb failed', err); }
      try { turn.onChunkEnd?.(item); } catch (err) { console.warn('[voice] end cb failed', err); }
      turn.chunksPlayed++;
    }
  }
  maybePlaybackComplete(turn);
  maybeDisposeTurn(turn);
}

// Stop everything: pre-buffer, scheduled sources, onStart timers; fire
// outstanding onPlaybackComplete hooks so per-turn UI tears down.
export function resetAudio(): void {
  if (bufferingTimer) { clearTimeout(bufferingTimer); bufferingTimer = null; }
  bufferingActive = false;
  pendingPlay = [];
  for (const src of scheduledSources) {
    try { src.onended = null; src.stop(); } catch { /* already stopped */ }
  }
  scheduledSources.clear();
  for (const t of pendingOnStartTimers) clearTimeout(t);
  pendingOnStartTimers.clear();
  lastScheduledEnd = 0;
  lastScheduledPacingChar = '';
  for (const turn of turns.values()) {
    markPurged(turn.synthId); // late chunks must not respawn audio
    if (turn.playbackCompleteFired) continue;
    turn.playbackCompleteFired = true;
    try { turn.onPlaybackComplete?.(); } catch (err) { console.warn('[voice] reset complete cb failed', err); }
    ttsLifecycle?.onTurnEnd();
  }
  turns.clear();
  // An in-flight replay's audio just died with the queue — release its button.
  currentReplay = null;
  replay.msgId = null;
}

// Stop ONE turn's audio without touching the rest of the queue: drop its
// pre-buffered items, stop its scheduled sources, cancel their onStart
// timers. Ported from voice.js purgeTurn; replay-stop is the consumer.
function purgeTurn(synthId: string): void {
  markPurged(synthId);
  pendingPlay = pendingPlay.filter((item) => item.synthId !== synthId);
  // Snapshot: the loop deletes from scheduledSources as it goes.
  // oxlint-disable-next-line unicorn/no-useless-spread
  for (const src of [...scheduledSources]) {
    if (src._mantleSynthId !== synthId) continue;
    if (src._mantleOnStartTimer) {
      clearTimeout(src._mantleOnStartTimer);
      pendingOnStartTimers.delete(src._mantleOnStartTimer);
    }
    try { src.onended = null; src.stop(); } catch { /* already stopped */ }
    scheduledSources.delete(src);
  }
  // Queue now effectively empty → reset scheduling so the next turn
  // pre-buffers fresh instead of chasing a stale clock.
  if (scheduledSources.size === 0 && pendingPlay.length === 0) {
    lastScheduledEnd = 0;
    lastScheduledPacingChar = '';
  }
  const turn = turns.get(synthId);
  if (turn) {
    turn.doneSignaled = true;
    turn.pendingChunks.clear();
    turn.inflightDecodes.clear();
    maybePlaybackComplete(turn);
    maybeDisposeTurn(turn);
  }
}

// ── Voice-gated text reveal (port of wireVoiceTextReveal) ────────────────────

interface LiveWiring {
  synthId: string;
  msg: ChatMessage;
  part: TextPart | null; // created lazily on first reveal (keeps thinking above)
  island: ReturnType<typeof createIsland>;
  localBuffer: string;
  chunkTimer: ReturnType<typeof setInterval> | null;
  chunkRemaining: string;
}

let live: LiveWiring | null = null;

// Whether the voice room currently owns the live bubble's text (drives the
// text_delta claim — a NEW turn pushes a new assistant message, which releases
// the claim automatically even if tts_done is still in flight).
function voiceOwnsText(): boolean {
  if (!live) return false;
  const last = chat.messages[chat.messages.length - 1];
  return last === live.msg;
}

function wireLiveTurn(turn: VoiceTurn): void {
  const msg = chat.messages[chat.messages.length - 1];
  if (!msg || msg.role !== 'assistant' || !msg.streaming) return; // audio-only fallback
  if (live) releaseWiring(live); // defensive — a new voice turn supersedes

  const w: LiveWiring = {
    synthId: turn.synthId,
    msg,
    part: null,
    island: createIsland(),
    localBuffer: '',
    chunkTimer: null,
    chunkRemaining: '',
  };
  live = w;
  msg.voiceLive = true;

  // Lazily mount the text part on first reveal so thinking blocks (which
  // stream before any audio chunk lands) keep their natural order above.
  const append = (slice: string): void => {
    if (!w.part) {
      w.msg.parts.push({ kind: 'text', id: crypto.randomUUID(), active: true, island: w.island });
      w.part = w.msg.parts[w.msg.parts.length - 1] as TextPart; // reactive proxy
    }
    w.localBuffer += slice;
    w.island.push(slice);
  };

  turn.onChunkReveal = (item) => {
    const text = item.text || '';
    if (!text) return;
    if (w.chunkTimer) { clearInterval(w.chunkTimer); w.chunkTimer = null; }

    // Chunker trims trailing whitespace — restore the seam space between
    // sentences, unless the chunk leads with its own (paragraph break).
    if (w.localBuffer && !/\s$/.test(w.localBuffer) && !/^\s/.test(text)) append(' ');

    const duration = item.buffer?.duration ?? 0;
    if (duration <= 0) { append(text); return; } // error chunk → instant

    // Pace the reveal to the audio: undershoot slightly (never read ahead of
    // the voice); onChunkEnd snaps any tail.
    w.chunkRemaining = text;
    const totalTicks = Math.max(1, (duration * 1000) / REVEAL_TICK_MS);
    const tickChars = Math.max(1, Math.ceil(text.length / totalTicks));
    w.chunkTimer = setInterval(() => {
      if (!w.chunkRemaining) {
        if (w.chunkTimer) { clearInterval(w.chunkTimer); w.chunkTimer = null; }
        return;
      }
      const slice = w.chunkRemaining.slice(0, tickChars);
      w.chunkRemaining = w.chunkRemaining.slice(tickChars);
      append(slice);
    }, REVEAL_TICK_MS);
  };

  turn.onChunkEnd = () => {
    // Audio for this chunk finished — snap the rest so text never trails.
    if (w.chunkTimer) { clearInterval(w.chunkTimer); w.chunkTimer = null; }
    if (w.chunkRemaining) { append(w.chunkRemaining); w.chunkRemaining = ''; }
  };

  turn.onPlaybackComplete = () => releaseWiring(w);
}

// Finish a wiring: snap leftovers, drain + finalize its island, clear flags.
function releaseWiring(w: LiveWiring): void {
  if (w.chunkTimer) { clearInterval(w.chunkTimer); w.chunkTimer = null; }
  if (w.chunkRemaining) {
    w.localBuffer += w.chunkRemaining;
    w.island.push(w.chunkRemaining);
    w.chunkRemaining = '';
  }
  const part = w.part;
  if (part) part.raw = w.localBuffer; // make the finalized bubble replayable
  w.island.setOnDone(() => { if (part) part.active = false; });
  w.island.end();
  w.msg.voiceLive = false;
  if (live === w) live = null;
}

// ── Per-message replay (speaker buttons on assistant bubbles) ────────────────

// One replay at a time, like the vanilla UI: clicking the playing message
// stops it; clicking another stops the current one first, then starts.
export const replay = $state({ msgId: null as string | null });
let currentReplay: { replayId: string; synthId: string | null; msgId: string } | null = null;

// Which engine serves a replay: the active toggle, else warm chatterbox
// (toggle off but model loaded — replay is a different intent), else xAI.
function getReplayProvider(): 'chatterbox' | 'xai' {
  if (voice.cb === 'on') return 'chatterbox';
  if (voice.xai === 'on') return 'xai';
  if (voice.sidecarReady && voice.ttsLoaded) return 'chatterbox';
  if (voice.xaiAvailable) return 'xai';
  return 'chatterbox';
}

// The spoken text of a finalized message: transcript parts carry `text`,
// finalized live runs carry `raw` (accumulated as they streamed). Raw
// markdown is fine — the synth pipeline normalizes it server-side, same as
// a live voice turn's deltas.
export function messageReplayText(msg: ChatMessage): string {
  const out: string[] = [];
  for (const p of msg.parts) {
    if (p.kind !== 'text') continue;
    const t = (p.text ?? p.raw ?? '').trim();
    if (t) out.push(t);
  }
  return out.join('\n\n').trim();
}

export async function replayMessage(msg: ChatMessage): Promise<void> {
  // Same message while playing → stop. Different message → stop, then start.
  if (currentReplay?.msgId === msg.id) { stopReplay(); return; }
  if (currentReplay) stopReplay();

  const agentId = ui.currentAgentId;
  const text = messageReplayText(msg);
  if (!agentId || !text) return;

  const replayId = crypto.randomUUID();
  currentReplay = { replayId, synthId: null, msgId: msg.id };
  replay.msgId = msg.id;
  try {
    await sendWs({ type: 'replay', agentId, text, replayId, voiceProvider: getReplayProvider() });
  } catch {
    if (currentReplay?.replayId === replayId) { currentReplay = null; replay.msgId = null; }
  }
}

// `silent` skips the WS send — pure local cleanup (connection already gone).
export function stopReplay(opts: { silent?: boolean } = {}): void {
  if (!currentReplay) return;
  const { replayId, synthId } = currentReplay;
  if (!opts.silent) sendWs({ type: 'replay_stop', replayId }).catch(() => {});
  if (synthId) purgeTurn(synthId);
  currentReplay = null;
  replay.msgId = null;
}

// ── WS event handling (registered on the room seam) ─────────────────────────

interface TtsEvent extends WsEvent {
  synthId?: string;
  replayId?: string;
  chunkIdx?: number;
  audioBase64?: string;
  pacingChar?: string;
}

function audioPlayable(): boolean {
  return (voice.sidecarReady && voice.ttsLoaded) || voice.xaiAvailable;
}

function handleVoiceEvent(raw: WsEvent): void {
  const ev = raw as TtsEvent;
  switch (ev.type) {
    case 'text_delta':
      // Claimed + dropped: in a voice turn the reveal is audio-paced — the
      // user must not read ahead of the voice.
      return;
    case 'tts_start': {
      if (!audioPlayable()) return;
      const turn = getOrCreateTurn(ev.synthId);
      if (!turn) return;
      ttsLifecycle?.onTurnStart(); // mic pauses for replays + live turns alike
      if (ev.replayId) {
        // Replay turn: audio only — the bubble's text is already on screen.
        // Bind the synthId so stop can purge, and flip the button back when
        // playback completes (guarded: a newer click may have moved on).
        turn.replayId = ev.replayId;
        if (currentReplay && currentReplay.replayId === ev.replayId) {
          currentReplay.synthId = turn.synthId;
          const rid = ev.replayId;
          turn.onPlaybackComplete = () => {
            if (currentReplay?.replayId === rid) { currentReplay = null; replay.msgId = null; }
          };
        }
        return;
      }
      wireLiveTurn(turn);
      return;
    }
    case 'tts_audio': {
      if (!audioPlayable()) return;
      const turn = getOrCreateTurn(ev.synthId);
      if (!turn) return;
      const idx = ev.chunkIdx ?? 0;
      const text = ev.text ?? '';
      const timing = ensureChunkTiming(turn, idx);
      timing.wsReceivedMs = performance.now() - turn.receivedAt;
      const decodeStart = performance.now();
      const decodePromise: Promise<void> = decodeBase64Wav(ev.audioBase64 ?? '')
        .then((buffer) => {
          timing.decodeMs = performance.now() - decodeStart;
          turn.pendingChunks.set(idx, { buffer, idx, text, pacingChar: ev.pacingChar });
          drainTurn(turn);
        })
        .catch((err: unknown) => {
          console.warn('[voice] decode failed for chunk', idx, err);
          turn.pendingChunks.set(idx, { buffer: null, idx, text, pacingChar: ev.pacingChar, error: 'decode failed' });
          drainTurn(turn);
        })
        .finally(() => {
          turn.inflightDecodes.delete(decodePromise);
          maybePlaybackComplete(turn);
          maybeDisposeTurn(turn);
        });
      turn.inflightDecodes.add(decodePromise);
      return;
    }
    case 'tts_error': {
      console.warn('[voice] tts error chunk', ev.chunkIdx, ev.error);
      // Pre-pipeline replay failure carries only a replayId (no synthId) —
      // release the button. (The vanilla UI dropped these and the speaker
      // stuck on "playing".)
      if (ev.replayId && !ev.synthId && currentReplay?.replayId === ev.replayId) {
        currentReplay = null;
        replay.msgId = null;
        return;
      }
      if (!audioPlayable()) return;
      const turn = getOrCreateTurn(ev.synthId);
      if (!turn) return;
      const idx = ev.chunkIdx ?? 0;
      turn.pendingChunks.set(idx, { buffer: null, idx, text: ev.text ?? '', error: ev.error });
      drainTurn(turn);
      return;
    }
    case 'tts_done': {
      const turn = ev.synthId ? turns.get(ev.synthId) : null;
      if (!turn) return;
      // Short reply still pre-buffering → flush now, nothing more is coming.
      if (bufferingActive && pendingPlay.length > 0) flushBufferedPlay();
      turn.doneSignaled = true;
      maybePlaybackComplete(turn);
      maybeDisposeTurn(turn);
      return;
    }
    case 'tts_unavailable':
      // Server can't deliver voice this turn (sent INSTEAD of tts_start, so
      // no wiring exists) — text_deltas flow to the normal reveal path.
      return;
    default:
      return;
  }
}

// Turn-fatal error (abort, provider failure) — observed, not claimed: core
// still finalizes the turn; we stop the audio + release the bubble. The one
// REQUEST-scoped error (a busy note rejection mid-turn) must not kill audio.
function onTurnError(ev: WsEvent): void {
  if (chat.isStreaming && (ev.error ?? '').includes('busy')) return;
  if (live || turns.size > 0 || scheduledSources.size > 0) resetAudio();
}

// ── Availability + load orchestration ────────────────────────────────────────

interface VoiceStatus {
  tts?: string;
  voices?: Record<string, boolean>;
  selectedVoices?: Record<string, string | null>;
  availableVoices?: string[];
}

async function fetchStatus(): Promise<VoiceStatus | null> {
  // Lean install: with the voice feature off the endpoint is a guaranteed 503
  // — skip the probe entirely (README promise: a disabled feature never
  // probes). Re-enabled via Settings → the next status refresh runs normally.
  if (getFeature('voice')?.enabled !== true) {
    voice.sidecarReady = false;
    voice.ttsLoaded = false;
    return null;
  }
  try {
    const r = await fetch('/api/voice/status');
    if (!r.ok) {
      voice.sidecarReady = false;
      voice.ttsLoaded = false;
      return null;
    }
    const data = (await r.json()) as VoiceStatus;
    voice.sidecarReady = true;
    voicesByAgent = data.voices ?? {};
    selectedVoicesMap = data.selectedVoices ?? {};
    voice.availableVoices = data.availableVoices ?? [];
    voice.ttsLoaded = data.tts === 'loaded';
    refreshSelectedVoice();
    return data;
  } catch {
    voice.sidecarReady = false;
    voice.ttsLoaded = false;
    return null;
  }
}

function refreshSelectedVoice(): void {
  const id = ui.currentAgentId;
  if (!id) { voice.selectedVoice = null; return; }
  voice.selectedVoice =
    selectedVoicesMap[id] ??
    (voice.availableVoices.includes(`${id}.wav`) ? `${id}.wav` : null);
  voice.selectedXaiVoice = xaiVoicesByAgent[id] ?? voice.defaultXaiVoice;
}

let pollHandle: ReturnType<typeof setInterval> | null = null;

export async function refreshAvailability(): Promise<void> {
  const data = await fetchStatus();
  await refreshXaiAvailability(); // independent of the sidecar

  if (!data) { voice.cb = 'unavailable'; return; }
  const agentId = ui.currentAgentId;
  if (!agentId || voicesByAgent[agentId] !== true) { voice.cb = 'unavailable'; return; }

  // Sidecar up + voice file present. A refresh after a prior session can see
  // tts already loaded — honor the user's last explicit toggle intent over
  // server state, and keep the two toggles mutually exclusive.
  if (lsGet(LS_XAI_INTENT) === 'on' && voice.xai === 'on') { voice.cb = 'off'; return; }
  if (data.tts === 'loaded' && lsGet(LS_CB_INTENT) === 'off') { voice.cb = 'off'; return; }
  if (data.tts === 'loaded') voice.cb = 'on';
  else if (data.tts === 'loading') { voice.cb = 'loading'; startLoadPolling(); }
  else if (data.tts === 'failed') voice.cb = 'failed';
  else voice.cb = 'off';
}

interface ConfigLite {
  features?: Record<string, boolean>;
  xaiVoices?: string[];
  defaultXaiVoice?: string;
  agents?: Array<{ id?: string; xaiVoice?: string }>;
}

async function refreshXaiAvailability(): Promise<void> {
  try {
    const r = await fetch('/api/config');
    if (!r.ok) { voice.xaiAvailable = false; voice.xai = 'unavailable'; return; }
    const cfg = (await r.json()) as ConfigLite;
    voice.xaiAvailable = cfg.features?.xaiTts === true;
    if (Array.isArray(cfg.xaiVoices) && cfg.xaiVoices.length) voice.xaiVoiceCatalog = cfg.xaiVoices;
    if (typeof cfg.defaultXaiVoice === 'string') voice.defaultXaiVoice = cfg.defaultXaiVoice;
    xaiVoicesByAgent = {};
    for (const a of cfg.agents ?? []) {
      if (a?.id) xaiVoicesByAgent[a.id] = a.xaiVoice ?? null;
    }
    refreshSelectedVoice();
    if (!voice.xaiAvailable) { voice.xai = 'unavailable'; return; }
    // Configured — require the explicit saved intent; never auto-resurrect.
    if (voice.cb === 'on') { voice.xai = 'off'; return; }
    voice.xai = lsGet(LS_XAI_INTENT) === 'on' ? 'on' : 'off';
  } catch {
    voice.xaiAvailable = false;
    voice.xai = 'unavailable';
  }
}

function startLoadPolling(): void {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(() => {
    void (async () => {
      const data = await fetchStatus();
      if (!data) {
        if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
        voice.cb = 'unavailable';
        return;
      }
      if (data.tts === 'loaded') {
        if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
        // Pre-warm CUDA kernels before flipping on — without it the first
        // reply pays ~5-7s of JIT cost. One continuous perceived load.
        try { await preWarmTts(); } catch (err) { console.warn('[voice] pre-warm failed (proceeding)', err); }
        voice.cb = 'on';
        void ensureAudioContext().resume?.();
      } else if (data.tts === 'failed') {
        if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
        voice.cb = 'failed';
      }
    })();
  }, 700);
}

// One discarded synth round-trip — only the warm kernels + cached voice
// conditionals matter.
async function preWarmTts(): Promise<void> {
  const agentId = ui.currentAgentId;
  if (!agentId) return;
  const r = await fetch('/api/voice/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, sample: 'Warm up.', params: {} }),
  });
  if (!r.ok) throw new Error(`pre-warm preview returned ${r.status}`);
  await r.arrayBuffer();
}

// ── Toggles ──────────────────────────────────────────────────────────────────

export function toggleChatterbox(): void {
  if (voice.cb === 'unavailable' || voice.cb === 'loading') return;
  if (voice.cb === 'on') {
    resetAudio();
    voice.cb = 'off';
    lsSet(LS_CB_INTENT, 'off');
    // Hand the TTS VRAM back (local models compete for it). STT stays — the
    // mic owns that independently. Fire-and-forget; re-enable pays a fresh
    // load + pre-warm.
    fetch('/api/voice/unload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tts: true, stt: false }),
    }).catch(() => {});
    return;
  }
  if (voice.xai === 'on') { voice.xai = 'off'; lsSet(LS_XAI_INTENT, 'off'); } // mutual exclusion
  lsSet(LS_CB_INTENT, 'on');
  voice.cb = 'loading';
  fetch('/api/voice/load', { method: 'POST' })
    .then(() => startLoadPolling())
    .catch((err: unknown) => {
      console.error('[voice] load request failed', err);
      voice.cb = 'failed';
    });
}

export function toggleXai(): void {
  if (voice.xai === 'unavailable') return;
  if (voice.xai === 'on') {
    resetAudio();
    voice.xai = 'off';
    lsSet(LS_XAI_INTENT, 'off');
    return;
  }
  // Flip chatterbox off (mutually exclusive) WITHOUT unloading — keeps the
  // model warm so flipping back is free.
  if (voice.cb === 'on') { voice.cb = 'off'; lsSet(LS_CB_INTENT, 'off'); }
  lsSet(LS_XAI_INTENT, 'on');
  voice.xai = 'on';
  void ensureAudioContext().resume?.(); // unlock so the first synth plays immediately
}

export function onConnectionLost(): void {
  voice.sidecarReady = false;
  voice.cb = 'unavailable';
  voice.xaiAvailable = false;
  voice.xai = 'unavailable';
  stopReplay({ silent: true }); // the WS (and the synth behind it) is gone
}

// ── Voice selectors ──────────────────────────────────────────────────────────

export async function selectVoiceFile(filename: string): Promise<void> {
  const agentId = ui.currentAgentId;
  if (!agentId) return;
  voice.selectedVoice = filename; // optimistic
  try {
    await updateAgent(agentId, { voiceFile: filename });
    void refreshAvailability(); // toggle reflects the new file's existence
  } catch (err) {
    console.error('[voice] voice-file save failed', err);
    void refreshAvailability(); // rollback to server truth
  }
}

export async function selectXaiVoice(voiceName: string): Promise<void> {
  const agentId = ui.currentAgentId;
  if (!agentId || !voiceName) return;
  xaiVoicesByAgent[agentId] = voiceName; // optimistic
  voice.selectedXaiVoice = voiceName;
  try {
    await updateAgent(agentId, { xaiVoice: voiceName });
  } catch (err) {
    console.error('[voice] xai-voice save failed', err);
    void refreshAvailability();
  }
}

export function voiceLabelFromFile(filename: string): string {
  return filename.replace(/\.wav$/i, '').replace(/[-_]+/g, ' ').trim();
}

// ── Registration (idempotent; called from VoiceHost) ─────────────────────────

let registered = false;

export function registerVoice(): void {
  if (registered) return;
  registered = true;
  // Claim tts_* always; claim text_delta only while a live voice turn owns
  // the last bubble (a new turn's bubble releases the claim automatically).
  onWsEvent(
    (type) => type.startsWith('tts_') || (type === 'text_delta' && voiceOwnsText()),
    handleVoiceEvent,
  );
  // Observe turn errors (do NOT claim — core finalizes the turn).
  onWsEvent((type) => type === 'error', onTurnError, { claim: false });
  // Outbound: tag turns with voiceMode/voiceProvider while a toggle is on.
  onTurnOptions((payload) => {
    const provider = voice.cb === 'on' ? 'chatterbox' : voice.xai === 'on' ? 'xai' : null;
    if (provider) {
      payload.voiceMode = true;
      payload.voiceProvider = provider;
    }
  });
}
