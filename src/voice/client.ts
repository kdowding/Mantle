// HTTP client for the python voice sidecar. Thin wrappers around the
// FastAPI endpoints in voice/server.py — no business logic lives here.
//
// All methods throw on non-2xx responses so callers can use try/catch
// without checking status codes manually.

export type EngineState = "unloaded" | "loading" | "loaded" | "unloading" | "failed";

export interface VoiceStatus {
  tts: EngineState;
  stt: EngineState;
  tts_error: string | null;
  stt_error: string | null;
  sample_rate: number;
  tts_device: string;
  stt_device: string;
}

export interface LoadOptions {
  tts?: boolean;
  stt?: boolean;
}

export interface SynthOptions {
  text: string;
  voiceRef: string;
  // chatterbox-streaming exposes only these three runtime knobs via
  // generate_stream. top_k / top_p / repetition_penalty / cfm_timesteps
  // are no longer tunable per-call (they were turbo-era knobs).
  temperature?: number;
  // Classifier-free guidance — speaker-conditioning strength. 0.0 = no
  // anchoring (model prior leaks); 1.0 = strong speaker fidelity. The
  // accent-anchoring knob turbo dropped that we got back here.
  cfgWeight?: number;
  // Emotion intensity (0.0 flat → 1.0 highly expressive, default 0.5).
  // Baked into the sidecar's cached T3Cond via prepare_conditionals.
  // Changing this triggers a re-prepare on the python side (cheap on
  // subsequent calls).
  exaggeration?: number;
  // True when the caller has already normalized the text on the JS side
  // (we don't currently — normalizer is python-only — but the field is
  // here for symmetry with the sidecar API).
  skipNormalize?: boolean;
  // Abort signal threaded through to fetch. When aborted, the HTTP
  // connection to the sidecar closes; the python side's StreamingResponse
  // generator exits, releasing the synth lock for the next call.
  // Without this, replay_stop would only stop WS shipping — the python
  // side would keep generating until the model finished, blocking the
  // next replay or chat for the full remaining synth duration.
  signal?: AbortSignal;
}

// Per-sub-chunk audio event. Each sub-chunk is a complete WAV (with
// header) so the browser's decodeAudioData can decode independently —
// small overhead (~44 bytes/header) is negligible vs the audio payload.
export interface SynthAudioEvent {
  kind: "audio";
  subIdx: number;       // sub-chunk index within this synth call (0..n-1)
  audio: Uint8Array;    // WAV bytes, ready for decodeAudioData
  sampleRate: number;
  isFirst: boolean;     // true on subIdx===0 (carries the chunk's text)
  // True on the last sub-chunk of this synth call. Used by ws.ts to set
  // pacingChar — the inter-sentence pause cue that drives voice.js's
  // 250ms-after-period delay between logical chunks.
  isLast: boolean;
  elapsedMs: number;    // wall-clock from synth call start to this sub-chunk
  audioMs: number;      // duration of this sub-chunk's audio
}

// Final synth-stream marker with summary stats — one per call, last event.
export interface SynthDoneEvent {
  kind: "done";
  chars: number;
  audioTotalMs: number;
  synthTotalMs: number;
  ttfbMs: number;       // time-to-first-sub-chunk from this synth call
  numSubChunks: number;
}

export type SynthStreamEvent = SynthAudioEvent | SynthDoneEvent;

// Legacy shape kept for the per-turn log's recordSynthResponse signature
// — built on the JS side from a SynthDoneEvent at end-of-stream.
export interface SynthMeta {
  chars: number;
  audio_total_ms: number;
  synth_total_ms: number;
  ttfb_ms: number;
  num_sub_chunks: number;
}

// One-shot result kept for the preview path (tuning modal). Live chat
// uses synthesizeStream; preview uses synthesizePreview to get a single
// concatenated WAV.
export interface SynthResult {
  audio: Uint8Array;
  sampleRate: number;
  normalizedText: string;
}

export interface TranscribeOptions {
  audio: Uint8Array;     // raw WAV bytes — browser packs Float32 → 16-bit PCM → WAV
  language?: string;     // ISO code (e.g. "en"); omit for Whisper auto-detect
}

export interface TranscribeResult {
  text: string;
  language: string;
  languageProbability: number;
  audioDurationS: number;
  inferenceMs: number;
}

// Word-timestamped transcript of a full audio file (the karaoke path).
export interface TranscriptWord {
  start: number;
  end: number;
  word: string;
  probability: number;
}
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
}
export interface SongTranscript {
  text: string;
  language: string;
  languageProbability: number;
  audioDurationS: number;
  inferenceMs: number;
  segments: TranscriptSegment[];
}

export class VoiceClient {
  constructor(private readonly baseUrl: string) {}

  async health(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (!r.ok) return false;
      const body = await r.json() as { ok?: boolean };
      return body.ok === true;
    } catch {
      return false;
    }
  }

  async status(): Promise<VoiceStatus> {
    const r = await fetch(`${this.baseUrl}/voice/status`);
    if (!r.ok) throw new Error(`status failed: ${r.status} ${r.statusText}`);
    return await r.json() as VoiceStatus;
  }

  async load(opts: LoadOptions = {}): Promise<VoiceStatus> {
    // STT defaults to false — mantle's TTS-only flows shouldn't pull
    // faster-whisper into VRAM. Mic-in flows opt in by passing stt=true.
    const r = await fetch(`${this.baseUrl}/voice/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tts: opts.tts ?? true, stt: opts.stt ?? false }),
    });
    if (!r.ok) throw new Error(`load failed: ${r.status} ${r.statusText}`);
    return await r.json() as VoiceStatus;
  }

  async unload(opts: LoadOptions = {}): Promise<VoiceStatus> {
    const r = await fetch(`${this.baseUrl}/voice/unload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tts: opts.tts ?? true, stt: opts.stt ?? true }),
    });
    if (!r.ok) throw new Error(`unload failed: ${r.status} ${r.statusText}`);
    return await r.json() as VoiceStatus;
  }

  // Wait for both engines to reach a terminal state ("loaded" or "failed").
  // Used by the manager when the user toggles voice mode on — UI is blocked
  // until this resolves so we know the model is actually ready (or failed
  // and we can surface an error).
  async waitForLoaded(opts: { timeoutMs?: number; pollMs?: number; needs?: ("tts" | "stt")[] } = {}): Promise<VoiceStatus> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const pollMs = opts.pollMs ?? 500;
    const needs = opts.needs ?? ["tts", "stt"];
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const s = await this.status();
      const allReady = needs.every((n) => s[n] === "loaded" || s[n] === "failed");
      if (allReady) return s;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`Voice load timed out after ${timeoutMs}ms`);
  }

  // Stream synthesis events as the sidecar emits them. Each yielded item
  // is a SynthAudioEvent (per sub-chunk) followed by exactly one
  // SynthDoneEvent at end-of-stream. Errors throw.
  //
  // Yields:
  //   - SynthAudioEvent — one per ~25-token sub-chunk from the model
  //   - SynthDoneEvent — once, last; carries summary stats for the log
  //
  // Used by the live chat path in ws.ts where we want sub-chunks to ship
  // to the browser as they arrive (not after full sentence synth). For a
  // single binary WAV (preview / tuning modal), use synthesizePreview.
  async *synthesizeStream(opts: SynthOptions): AsyncGenerator<SynthStreamEvent, void, void> {
    const body = {
      text: opts.text,
      voice_ref: opts.voiceRef,
      temperature: opts.temperature,
      cfg_weight: opts.cfgWeight,
      exaggeration: opts.exaggeration,
      skip_normalize: opts.skipNormalize ?? false,
    };
    const cleanBody = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));

    const r = await fetch(`${this.baseUrl}/voice/tts/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cleanBody),
      signal: opts.signal,
    });
    if (!r.ok) {
      let detail = `${r.status} ${r.statusText}`;
      try {
        const errBody = await r.json() as { detail?: string };
        if (errBody.detail) detail = errBody.detail;
      } catch { /* not json */ }
      throw new Error(`synthesize failed: ${detail}`);
    }
    if (!r.body) throw new Error("synthesize: response has no body");

    const sampleRate = parseInt(r.headers.get("X-Sample-Rate") ?? "24000", 10);
    const reader = r.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(line) as Record<string, unknown>;
          } catch {
            throw new Error(`synthesize: malformed NDJSON line: ${line.slice(0, 80)}`);
          }
          if (parsed.error) throw new Error(`synthesize: sidecar error: ${parsed.error}`);
          if (parsed.is_final) {
            yield {
              kind: "done",
              chars: parsed.chars as number,
              audioTotalMs: parsed.audio_total_ms as number,
              synthTotalMs: parsed.synth_total_ms as number,
              ttfbMs: (parsed.ttfb_ms as number) ?? 0,
              numSubChunks: parsed.num_sub_chunks as number,
            };
          } else {
            // Decode the base64 audio payload. atob → binary string → Uint8Array.
            const audioB64 = parsed.audio_b64 as string;
            const binary = atob(audioB64);
            const audio = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) audio[i] = binary.charCodeAt(i);
            yield {
              kind: "audio",
              subIdx: parsed.sub_idx as number,
              audio,
              sampleRate: (parsed.sample_rate as number) ?? sampleRate,
              isFirst: parsed.is_first as boolean,
              isLast: (parsed.is_last as boolean) ?? false,
              elapsedMs: parsed.elapsed_ms as number,
              audioMs: parsed.audio_ms as number,
            };
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }

  // Non-streaming synth — one binary WAV, used by the tuning modal.
  // Hits a separate sidecar endpoint that drains the stream and concats
  // server-side. (Keeps the modal simple — no NDJSON parsing for a UI
  // path that doesn't benefit from streaming.)
  async synthesizePreview(opts: SynthOptions): Promise<SynthResult> {
    const body = {
      text: opts.text,
      voice_ref: opts.voiceRef,
      temperature: opts.temperature,
      cfg_weight: opts.cfgWeight,
      exaggeration: opts.exaggeration,
      skip_normalize: opts.skipNormalize ?? false,
    };
    const cleanBody = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));

    const r = await fetch(`${this.baseUrl}/voice/tts/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cleanBody),
    });
    if (!r.ok) {
      let detail = `${r.status} ${r.statusText}`;
      try {
        const errBody = await r.json() as { detail?: string };
        if (errBody.detail) detail = errBody.detail;
      } catch { /* not json */ }
      throw new Error(`synthesize preview failed: ${detail}`);
    }
    return {
      audio: new Uint8Array(await r.arrayBuffer()),
      sampleRate: parseInt(r.headers.get("X-Sample-Rate") ?? "24000", 10),
      normalizedText: r.headers.get("X-Normalized-Text") ?? "",
    };
  }

  // POST raw WAV bytes → faster-whisper transcript. Browser-side VAD has
  // already endpointed the utterance; we POST one complete clip per turn
  // (not streaming PCM frames). Caller fills opts.language only if they
  // want to skip Whisper's auto-detect for the latency win.
  async transcribe(opts: TranscribeOptions): Promise<TranscribeResult> {
    const url = new URL(`${this.baseUrl}/voice/stt/transcribe`);
    if (opts.language) url.searchParams.set("language", opts.language);

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      // Cast: TS 5.7 made Uint8Array generic (Uint8Array<ArrayBufferLike>)
      // but BodyInit still expects the pre-generic form. Runtime accepts any
      // TypedArray as a fetch body — browsers, Bun, Node all do. Strict-mode
      // types just haven't caught up.
      body: opts.audio as BodyInit,
    });
    if (!r.ok) {
      let detail = `${r.status} ${r.statusText}`;
      try {
        const errBody = await r.json() as { detail?: string };
        if (errBody.detail) detail = errBody.detail;
      } catch { /* not json */ }
      throw new Error(`transcribe failed: ${detail}`);
    }

    const data = await r.json() as {
      text: string;
      language: string;
      language_probability: number;
      audio_duration_s: number;
      inference_ms: number;
    };
    return {
      text: data.text,
      language: data.language,
      languageProbability: data.language_probability,
      audioDurationS: data.audio_duration_s,
      inferenceMs: data.inference_ms,
    };
  }

  // Transcribe a full audio FILE on disk (a song mp3) WITH word-level
  // timestamps — the karaoke path. The sidecar shares our filesystem
  // (loopback), so we hand it the absolute path instead of uploading bytes.
  async transcribeSong(opts: { path: string; language?: string }): Promise<SongTranscript> {
    const r = await fetch(`${this.baseUrl}/voice/stt/transcribe_song`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: opts.path, language: opts.language }),
    });
    if (!r.ok) {
      let detail = `${r.status} ${r.statusText}`;
      try {
        const errBody = await r.json() as { detail?: string };
        if (errBody.detail) detail = errBody.detail;
      } catch { /* not json */ }
      throw new Error(`song transcribe failed: ${detail}`);
    }
    const d = await r.json() as {
      text: string;
      language: string;
      language_probability: number;
      audio_duration_s: number;
      inference_ms: number;
      segments: TranscriptSegment[];
    };
    return {
      text: d.text,
      language: d.language,
      languageProbability: d.language_probability,
      audioDurationS: d.audio_duration_s,
      inferenceMs: d.inference_ms,
      segments: d.segments ?? [],
    };
  }
}
