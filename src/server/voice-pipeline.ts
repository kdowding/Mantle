// Text-to-speech pipeline: turns an agent's streaming reply text into
// audio chunks streamed back over the WebSocket. Two engines behind one
// shared VoicePipeline shape:
//   - chatterbox: local python sidecar (voice cloning, GPU, sub-chunk
//     streaming, mid-stream overshoot guard).
//   - xai: xAI's hosted TTS API (one POST per chunk, no sidecar, fixed
//     voice catalog).
//
// This module also owns the per-turn TTS tuning-log lifecycle
// (activeVoiceLogs + finalize scheduling): the log is kept alive after
// tts_done until the client's playback report arrives
// (applyPlaybackReport) or an audio-aware timeout fires.
//
// ws.ts drives this via buildVoicePipeline (chat + replay turns) and
// applyPlaybackReport (the tts_playback_report transport handler).

import type { ServerWebSocket } from "bun";
import { resolve } from "path";
import type { MantleConfig } from "../config/schema.js";
import { getAgent } from "../config/loader.js";
import { StreamChunker } from "../voice/stream-chunker.js";
import { TtsTurnLog, type ClientChunkReport } from "../voice/turn-log.js";
import type { SynthStreamEvent } from "../voice/client.js";
import { XaiTtsClient } from "../voice/xai-tts-client.js";
import type { VoiceManager } from "../voice/manager.js";
import type { WsData } from "./ws-types.js";
import { sendAudioFrame } from "./ws-send.js";

// Voice synthesis providers — defined in ws-types.ts (the leaf module) and
// re-exported here for the call sites that think of it as a pipeline
// concept. "chatterbox" = local python sidecar (voice cloning, GPU,
// sub-chunk streaming); "xai" = xAI's hosted TTS API. UI exposes them as
// two mutually-exclusive profile-bar toggles.
export type { VoiceProvider } from "./ws-types.js";
import type { VoiceProvider } from "./ws-types.js";

// Per-turn TTS tuning logs awaiting the client's playback report. Keyed
// by synthId. After tts_done is sent, we hold the log here until the
// client report arrives OR the audio-aware timeout fires (whichever
// comes first). The timeout has to outlast all queued audio because the
// client can only send the report after onPlaybackComplete fires.
// `owner` is the WebSocket the audio streamed to — playback reports are
// accepted only from it, so another authed connection can't finalize a
// log it never heard with fabricated timings.
const activeVoiceLogs = new Map<
  string,
  { log: TtsTurnLog; timer: ReturnType<typeof setTimeout> | null; owner: ServerWebSocket<WsData> }
>();
const VOICE_LOG_REPORT_BUFFER_MS = 30_000;     // headroom past audio end
const VOICE_LOG_FINALIZE_FLOOR_MS = 30_000;    // minimum wait even for tiny replies

function scheduleLogFinalize(synthId: string): void {
  const entry = activeVoiceLogs.get(synthId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  // Wait long enough for ALL synthesized audio to play out, plus a
  // buffer for the client's WS message round-trip. A 75s reply queued
  // at tts_done time still has 75s of audio to play; finalizing at a
  // hardcoded 30s would close the log before the playback report could
  // arrive (and we'd see an empty client-side timeline in the file).
  const audioMs = entry.log.totalAudioMs();
  const timeoutMs = Math.max(VOICE_LOG_FINALIZE_FLOOR_MS, audioMs + VOICE_LOG_REPORT_BUFFER_MS);
  entry.timer = setTimeout(() => finalizeAndRemoveLog(synthId), timeoutMs);
}

async function finalizeAndRemoveLog(synthId: string): Promise<void> {
  const entry = activeVoiceLogs.get(synthId);
  if (!entry) return;
  activeVoiceLogs.delete(synthId);
  if (entry.timer) clearTimeout(entry.timer);
  try {
    await entry.log.finalize();
  } catch (err) {
    console.warn(`[MANTLE:voice] log finalize threw: ${err instanceof Error ? err.message : err}`);
  }
}

// Merge the client's per-chunk playback timing into the kept-alive log,
// then finalize it (writes the log file). Called by ws.ts when a
// tts_playback_report arrives. No-op if the log already finalized (the
// audio-aware timeout fired first) or if the report comes from a
// connection other than the one the audio streamed to. The payload is
// client-supplied and written to disk — filter it to sane numeric chunk
// reports before merging.
export function applyPlaybackReport(
  synthId: string,
  chunks: ClientChunkReport[],
  ws: ServerWebSocket<WsData>,
): void {
  const entry = activeVoiceLogs.get(synthId);
  if (!entry) return;
  if (entry.owner !== ws) {
    console.warn(`[MANTLE:voice] playback report for ${synthId} from a non-owning connection — ignored`);
    return;
  }
  const sane = chunks
    .filter(
      (c): c is ClientChunkReport =>
        !!c &&
        typeof c === "object" &&
        Number.isFinite(c.chunkIdx) &&
        Number.isFinite(c.wsReceivedMs) &&
        Number.isFinite(c.decodeMs) &&
        Number.isFinite(c.playStartMs) &&
        Number.isFinite(c.playEndMs),
    )
    .slice(0, 1000);
  entry.log.applyClientReport(sane);
  if (entry.timer) clearTimeout(entry.timer);
  finalizeAndRemoveLog(synthId).catch(() => { /* finalize already logs */ });
}

// Strip paralinguistic tags ([chuckle], [laugh], [sigh], etc.) from the
// chunk text before it's shown in the UI. These tags are TTS hints — the
// chatterbox engine turns them into real sound effects in the audio — but
// they shouldn't appear as written text in the bubble. Also collapses
// horizontal-whitespace runs left over from a stripped tag so the seam
// reads naturally.
//
// Preserves NEWLINES and leading newlines (paragraph breaks the chunker
// kept on the leading edge). The UI renders `\n\n` as a markdown
// paragraph; collapsing them here would lose paragraph structure.
//
// Pragmatic regex: strips ANY [bracketed] content. In voice mode the
// system prompt instructs the model not to write notation/markdown, so
// any bracket content in the stream is overwhelmingly a TTS tag.
function stripDisplayTags(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/g, "");
}

// Walk back from the end past closing punctuation and whitespace to find
// the last "meaningful" character — used to set the pacingChar that
// drives voice.js's inter-sentence pause. Mirrors the same helper in
// voice.js (the fallback path) so both sides agree on what counts as a
// sentence-final character.
function _lastSignificantChar(text: string): string {
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === " " || ch === "\n" || ch === "\t") continue;
    if (ch === '"' || ch === "'" || ch === ")" || ch === "”" || ch === "’") continue;
    return ch;
  }
  return "";
}

// Common pipeline shape returned by both provider-specific builders.
// The agent loop / replay handler don't care which engine is behind
// this — they just feed text and await flushAndWait.
export interface VoicePipeline {
  synthId: string;
  feed: (text: string) => void;
  flushAndWait: () => Promise<void>;
  log: TtsTurnLog;
}

// Dispatch by provider. chatterbox needs voiceManager; xAI needs the
// Grok API key (read from config inside the builder). Returns null when
// the chosen provider isn't viable for this agent (sidecar down /
// missing voice file / missing API key).
export function buildVoicePipeline(
  provider: VoiceProvider,
  ws: ServerWebSocket<WsData>,
  config: MantleConfig,
  voiceManager: VoiceManager | undefined,
  agentId: string,
  abortSignal?: AbortSignal,
  replay: boolean = false,
  replayText?: string,
): VoicePipeline | null {
  if (provider === "xai") {
    return buildXaiVoicePipeline(ws, config, agentId, abortSignal, replay, replayText);
  }
  if (!voiceManager) return null;
  return buildChatterboxVoicePipeline(ws, config, voiceManager, agentId, abortSignal, replay, replayText);
}

// Voice synthesis pipeline (chatterbox / python sidecar variant). Wraps
// a StreamChunker so the agent loop's text_delta events feed sentence-
// bounded chunks into the TTS sidecar in parallel, but emit to the UI
// in arrival order. Returns null if voice mode is unavailable (sidecar
// down, voice file missing, etc).
function buildChatterboxVoicePipeline(
  ws: ServerWebSocket<WsData>,
  config: MantleConfig,
  voiceManager: VoiceManager,
  agentId: string,
  abortSignal?: AbortSignal,
  // For replay: skip the first-chunk-low-minChars optimization. Live
  // streaming uses a 30-char threshold for the opening chunk to cut
  // time-to-first-audio, but replay already has the full text — short
  // first chunks mean short audio runs that finish before the next
  // chunk's synth completes, producing audible silence gaps. Match the
  // regular minChars so chunks are sized for smooth back-to-back
  // playback.
  replay: boolean = false,
  // For replay: the full text being replayed. Stored on the turn log so
  // the file shows what was being synthesized. For live, append via the
  // returned `log.appendReplyText` from text_delta events.
  replayText?: string,
): VoicePipeline | null {
  // Resolve agent first so we can pass its `voiceFile` selection to the
  // voice manager. The selection (set via the profile-bar dropdown)
  // overrides the legacy `<agent-id>.wav` convention.
  const agentCfg = getAgent(config, agentId);
  const voiceRef = voiceManager.resolveVoiceRef(agentId, agentCfg?.voiceFile);
  if (!voiceRef) {
    console.warn(`[MANTLE:voice] voiceMode requested but no voice file resolved for agent ${agentId} — skipping`);
    return null;
  }

  const client = voiceManager.getClient();
  // Per-agent voice overrides win field-by-field; anything unset falls
  // through to the global defaults. The chatterbox-streaming knob set
  // is leaner than turbo's was — only temperature, cfgWeight (the new
  // accent-anchoring lever the streaming model gets back), and
  // exaggeration. The dropped turbo knobs (top_k, top_p, repetition_
  // penalty, cfm_timesteps) aren't exposed by generate_stream's API.
  const overrides = agentCfg?.voice ?? {};
  const baseDefaults = config.voice.defaults;
  const defaults = {
    temperature: overrides.temperature ?? baseDefaults.temperature,
    cfgWeight: overrides.cfgWeight ?? baseDefaults.cfgWeight,
    exaggeration: overrides.exaggeration ?? baseDefaults.exaggeration,
  };

  // Per-turn synthId, stamped on every voice event for this turn. Lets the
  // client keep voice state in a Map<synthId, VoiceTurn> instead of resetting
  // global state on tts_done — which races with in-flight async decodes and
  // can drop the final chunk. Each new turn gets a fresh id, naturally
  // garbage-collected on tts_done after decodes settle.
  const synthId = crypto.randomUUID();

  // Per-turn tuning log. Captures chunker emit/synth/ws timing on this
  // side; the client sends back receive/decode/play timing as a
  // tts_playback_report after onPlaybackComplete. finalize() is deferred
  // so we can wait for that report.
  const log = new TtsTurnLog({
    enabled: config.voice.turnLogs.enabled,
    baseDir: resolve(voiceManager.getBasePath(), ".mantle", "voice-logs"),
    agentId,
    synthId,
    voice: defaults,
    voiceRefPath: voiceRef,
    isReplay: replay,
    replayText: replayText,
    keepLast: config.voice.turnLogs.keepLast,
  });
  activeVoiceLogs.set(synthId, { log, timer: null, owner: ws });

  // Synth fires immediately per logical chunk (parallel) but WS emission
  // chains so sub-chunks ship in order. Two layers of pipelining:
  //   1. Sub-chunk N+1 of a logical chunk generates while sub-chunk N is
  //      shipping (model's internal generate_stream).
  //   2. Logical chunk N+1's synth starts as soon as the chunker emits it,
  //      while logical chunk N's audio is still streaming over WS.
  // The python sidecar's _synth_lock serializes the actual GPU calls so
  // the model state stays clean.
  let emitChain: Promise<void> = Promise.resolve();
  // Globally-flat sub-chunk index. The voice.js audio queue uses chunkIdx
  // for ordered release — incrementing it per sub-chunk (not per logical
  // chunk) lets the existing client-side ordering logic work unchanged.
  let globalSubIdx = 0;

  const chunker = new StreamChunker({
    // Replay overrides the first-chunk fast-path (default 30) by setting
    // it equal to the regular minChars (60), so all chunks are sized for
    // smooth back-to-back playback without synth/audio-duration gaps.
    firstChunkMinChars: replay ? 60 : undefined,
    onChunk: (text, idx) => {
      log.recordChunkEmit(idx, text);
      if (abortSignal?.aborted) return;
      // Synth gets the ORIGINAL text — paralinguistic tags like [chuckle]
      // are what trigger the sound effects in chatterbox. The display text
      // shipped to the UI gets those tags stripped so the user doesn't see
      // raw "[chuckle]" in the bubble.
      //
      // The chunker preserves leading whitespace (paragraph breaks) on
      // the chunk text for the UI's benefit. Strip it here before synth
      // so chatterbox doesn't see a leading `\n\n` — the python normalizer
      // would convert it to a leading `. ` which renders as a glottal
      // stop at chunk start.
      const synthText = text.replace(/^\s+/, "");
      const displayText = stripDisplayTags(text);

      // Start consuming the synth stream IMMEDIATELY so the python sidecar
      // begins generating in parallel. Events accumulate in a buffer; the
      // emitChain link below drains them in chunker-emit order.
      const eventBuffer: SynthStreamEvent[] = [];
      let producerDone = false;
      let producerError: Error | null = null;
      let resolveNext: (() => void) | null = null;
      const notify = () => { if (resolveNext) { const r = resolveNext; resolveNext = null; r(); } };

      // Mid-stream overshoot guard. The model occasionally produces
      // multi-second hallucinated tails (sighs, screams, elongated noise)
      // that span MULTIPLE sub-chunks. The python-side last-sub-chunk
      // trim only catches the FINAL sub-chunk's worth — by the time
      // we know the synth is done, the prior overshoot has already
      // shipped to the browser. This guard tracks cumulative audio
      // against an expected budget; when exceeded, we abort the synth
      // call mid-stream. The buffered audio that already shipped still
      // plays, but no further sub-chunks fire.
      //
      // Budget: text length / 12 chars/sec * 1.30 headroom. Effective
      // floor is ~9.2 chars/sec — anything slower is clear overshoot.
      // Min 4s for short texts where natural pauses (sentence-end ~250ms,
      // breath, decay) take a bigger fraction of total audio. A 13-char
      // text like "Sure thing!" can legitimately run 2-3s; below 4s
      // floor we'd false-abort on natural delivery.
      const overshootBudgetMs = Math.max(
        4000,
        Math.round(synthText.length / 12 * 1.30 * 1000),
      );
      const synthController = new AbortController();
      // Combine user-stop signal (abortSignal) with our synth-overshoot
      // signal so EITHER aborts the underlying fetch. Falls back to a
      // single signal if AbortSignal.any isn't available in this runtime.
      const combinedSignal: AbortSignal = abortSignal
        ? (typeof (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any === "function"
            ? (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any([abortSignal, synthController.signal])
            : abortSignal)
        : synthController.signal;

      const producerPromise = (async () => {
        let cumulativeAudioMs = 0;
        let overshootReason: string | null = null;
        try {
          for await (const ev of client.synthesizeStream({
            text: synthText,
            voiceRef,
            temperature: defaults.temperature,
            cfgWeight: defaults.cfgWeight,
            exaggeration: defaults.exaggeration,
            // Threading the abort signal into fetch closes the HTTP
            // connection to the sidecar on stop OR overshoot. Without
            // this, python keeps generating until the model finishes
            // and holds _synth_lock the whole time.
            signal: combinedSignal,
          })) {
            eventBuffer.push(ev);
            notify();
            if (combinedSignal.aborted) break;

            if (ev.kind === "audio") {
              cumulativeAudioMs += ev.audioMs;
              if (cumulativeAudioMs > overshootBudgetMs) {
                overshootReason = `cumulative=${cumulativeAudioMs}ms budget=${overshootBudgetMs}ms (text=${synthText.length}c)`;
                console.warn(`[MANTLE:voice] synth chunk ${idx} overshoot — aborting mid-stream: ${overshootReason}`);
                synthController.abort();
                break;
              }
            }
          }
        } catch (err) {
          // AbortError is expected on stop or overshoot — don't surface
          // it as a real synth error.
          if (combinedSignal.aborted || (err instanceof Error && err.name === "AbortError")) {
            // intentional abort — swallow (user-stop OR overshoot)
          } else {
            producerError = err instanceof Error ? err : new Error(String(err));
          }
        } finally {
          producerDone = true;
          notify();
        }
      })();

      emitChain = emitChain.then(async () => {
        let consumed = 0;
        let firstSubShipped = false;
        try {
          while (true) {
            // Drain whatever's available
            while (consumed < eventBuffer.length) {
              const ev = eventBuffer[consumed++]!;
              if (abortSignal?.aborted) return;
              if (ev.kind === "audio") {
                // Backpressure-gated: a saturated socket drops the frame
                // (audible gap) instead of buffering audio without bound.
                sendAudioFrame(ws, JSON.stringify({
                  type: "tts_audio",
                  synthId,
                  chunkIdx: globalSubIdx++,
                  // Text only on the FIRST sub-chunk of this logical chunk.
                  // voice.js's onChunkReveal returns early on empty text,
                  // so subsequent sub-chunks just play audio.
                  text: ev.isFirst ? displayText : "",
                  // Inter-sentence pacing cue. Set ONLY on the last sub-
                  // chunk of a logical chunk so voice.js applies the
                  // 250ms-after-period (or 80ms after comma/colon) gap
                  // before the next logical chunk's audio starts. Empty
                  // string on intra-sentence sub-chunks → no pause.
                  pacingChar: ev.isLast ? _lastSignificantChar(displayText) : "",
                  audioBase64: Buffer.from(ev.audio).toString("base64"),
                  sampleRate: ev.sampleRate,
                }), "tts_audio");
                if (!firstSubShipped) {
                  log.recordWsSend(idx);
                  firstSubShipped = true;
                }
              } else {
                // SynthDoneEvent — record final meta in the turn log
                log.recordSynthResponse(idx, {
                  chars: ev.chars,
                  audio_total_ms: ev.audioTotalMs,
                  synth_total_ms: ev.synthTotalMs,
                  ttfb_ms: ev.ttfbMs,
                  num_sub_chunks: ev.numSubChunks,
                });
              }
            }
            if (producerDone) {
              if (producerError) throw producerError;
              return;
            }
            // Wait for next event from the producer (no polling).
            await new Promise<void>((r) => { resolveNext = r; });
          }
        } catch (err) {
          if (abortSignal?.aborted) return;
          const message = err instanceof Error ? err.message : String(err);
          log.recordSynthError(idx, message);
          console.warn(`[MANTLE:voice] synth chunk ${idx} failed: ${message}`);
          try {
            ws.send(JSON.stringify({
              type: "tts_error",
              synthId,
              chunkIdx: globalSubIdx++,
              text: displayText,
              error: message,
            }));
          } catch { /* ws closed */ }
        } finally {
          // Make sure the producer settles even if we bailed early on abort.
          await producerPromise.catch(() => { /* already captured */ });
        }
      });
    },
  });

  return {
    synthId,
    feed: (text) => {
      // Live mode: accumulate the agent's reply text into the log so the
      // file's "Agent reply" section shows the full output. Replays
      // already have replayText set on the log at construction time.
      if (!replay) log.appendReplyText(text);
      chunker.feed(text);
    },
    flushAndWait: async () => {
      chunker.flush();
      await emitChain;
      try {
        ws.send(JSON.stringify({ type: "tts_done", synthId }));
      } catch { /* ws closed */ }
      // Defer log finalize: client has up to VOICE_LOG_FINALIZE_TIMEOUT_MS
      // to send back tts_playback_report with receive/decode/play timing.
      // Whichever happens first (report arrival or timeout) finalizes the
      // log and writes the file.
      scheduleLogFinalize(synthId);
    },
    log,
  };
}

// Voice synthesis pipeline (xAI hosted TTS variant). Same external
// shape as the chatterbox pipeline, but the synth path is simpler:
// one POST per chunk → one mp3 blob → one tts_audio event. No sub-chunk
// streaming, no overshoot guard (xAI doesn't hallucinate tails), no
// voice file resolution. Returns null when no Grok API key is configured.
function buildXaiVoicePipeline(
  ws: ServerWebSocket<WsData>,
  config: MantleConfig,
  agentId: string,
  abortSignal?: AbortSignal,
  replay: boolean = false,
  replayText?: string,
): VoicePipeline | null {
  const apiKey = config.providers.grok.apiKey;
  if (!apiKey) {
    console.warn(`[MANTLE:voice] xAI TTS requested but no XAI_API_KEY configured — skipping`);
    return null;
  }
  const agentCfg = getAgent(config, agentId);
  const voiceId = (agentCfg?.xaiVoice ?? config.realtime.defaultVoice ?? "ara").trim();
  const xaiClient = new XaiTtsClient(apiKey);

  const synthId = crypto.randomUUID();

  // Per-turn log. Captures chunker-emit / synth / ws timing. xAI is
  // single-shot per chunk so num_sub_chunks is always 1 and audio_total
  // _ms isn't known server-side (the client measures it via the
  // playback report). Tuning fields are blank — xAI doesn't expose the
  // chatterbox knobs.
  const log = new TtsTurnLog({
    enabled: config.voice.turnLogs.enabled,
    baseDir: resolve(config.basePath, ".mantle", "voice-logs"),
    agentId,
    synthId,
    voice: { temperature: 0, cfgWeight: 0, exaggeration: 0 },
    voiceRefPath: `xai:${voiceId}`,
    isReplay: replay,
    replayText,
    keepLast: config.voice.turnLogs.keepLast,
  });
  activeVoiceLogs.set(synthId, { log, timer: null, owner: ws });

  // Chained WS emits so chunks reach the browser in chunker-emit order
  // even though synth calls fire in parallel. (xAI returns the full
  // chunk audio in one fetch — no sub-chunk producer/consumer dance
  // like chatterbox needs.)
  let emitChain: Promise<void> = Promise.resolve();
  let globalIdx = 0;

  const chunker = new StreamChunker({
    firstChunkMinChars: replay ? 60 : undefined,
    onChunk: (text, idx) => {
      log.recordChunkEmit(idx, text);
      if (abortSignal?.aborted) return;

      const synthText = text.replace(/^\s+/, "");
      const displayText = stripDisplayTags(text);

      // Start synth IMMEDIATELY (parallel across chunks). emitChain
      // serializes the ws.send so chunkIdx ordering is preserved.
      const synthPromise = xaiClient.synthesize({
        text: synthText,
        voiceId,
        codec: "mp3",
        signal: abortSignal,
      });

      emitChain = emitChain.then(async () => {
        try {
          if (abortSignal?.aborted) return;
          const result = await synthPromise;
          if (abortSignal?.aborted) return;

          const chunkIdx = globalIdx++;
          sendAudioFrame(ws, JSON.stringify({
            type: "tts_audio",
            synthId,
            chunkIdx,
            text: displayText,
            // Inter-sentence pacing cue. xAI returns one audio per
            // chunk so every chunk gets a pacing char (vs chatterbox
            // which only sets it on the last sub-chunk).
            pacingChar: _lastSignificantChar(displayText),
            audioBase64: Buffer.from(result.audio).toString("base64"),
            // xAI returns mp3 with embedded 24kHz — sampleRate is
            // informational only since decodeAudioData parses the
            // container's own header. Kept for symmetry with the
            // chatterbox path.
            sampleRate: 24000,
          }), "tts_audio");
          log.recordWsSend(idx);
          log.recordSynthResponse(idx, {
            chars: synthText.length,
            audio_total_ms: 0,
            synth_total_ms: result.synthMs,
            ttfb_ms: result.synthMs,
            num_sub_chunks: 1,
          });
        } catch (err) {
          if (abortSignal?.aborted) return;
          const message = err instanceof Error ? err.message : String(err);
          log.recordSynthError(idx, message);
          console.warn(`[MANTLE:voice] xAI synth chunk ${idx} failed: ${message}`);
          try {
            ws.send(JSON.stringify({
              type: "tts_error",
              synthId,
              chunkIdx: globalIdx++,
              text: displayText,
              error: message,
            }));
          } catch { /* ws closed */ }
        }
      });
    },
  });

  return {
    synthId,
    feed: (text) => {
      if (!replay) log.appendReplyText(text);
      chunker.feed(text);
    },
    flushAndWait: async () => {
      chunker.flush();
      await emitChain;
      try {
        ws.send(JSON.stringify({ type: "tts_done", synthId }));
      } catch { /* ws closed */ }
      scheduleLogFinalize(synthId);
    },
    log,
  };
}
