// HTTP client for xAI's standalone Text-to-Speech REST API. Separate
// from the python chatterbox sidecar — this hits api.x.ai directly and
// returns one mp3 blob per call. Used when the user toggles "xAI" mode
// instead of "Chatterbox" in the profile bar.
//
// Endpoint: POST https://api.x.ai/v1/tts
// Auth:     Bearer XAI_API_KEY (same key as the Grok provider)
// Voices:   eve, ara, rex, sal, leo  (same catalog as realtime calls)
// Pricing:  ~$4.20 / 1M chars (xAI announcement, 2026-04)
//
// We deliberately use the REST endpoint instead of the WebSocket
// streaming endpoint (wss://api.x.ai/v1/tts). The chunker already emits
// sentence-sized fragments (~60-200 chars) which the REST endpoint
// synthesizes in ~300-500ms each — well below the perceptual latency
// budget. The WS endpoint's benefit is total-text-length unlimited; we
// don't need that since chunks are bounded.
//
// Output format: mp3 by default. The browser's decodeAudioData parses
// mp3 natively, so no per-chunk decoder switch is needed on the UI side.

export const XAI_TTS_ENDPOINT = "https://api.x.ai/v1/tts";

export const XAI_BUILTIN_VOICES = ["eve", "ara", "rex", "sal", "leo"] as const;
export type XaiVoice = typeof XAI_BUILTIN_VOICES[number] | string;

export interface XaiTtsOptions {
  text: string;
  voiceId: XaiVoice;
  // BCP-47 language code or "auto". xAI expects this even though the
  // model is multilingual — "auto" lets it detect from the input.
  language?: string;
  // Output container/codec. Default mp3 since decodeAudioData parses it
  // natively. wav works too if a caller wants lossless (preview path).
  codec?: "mp3" | "wav" | "pcm" | "mulaw" | "alaw";
  // mp3 only — bitrate. 128000 default matches xAI's. We don't expose
  // sample_rate; the default 24kHz is fine for everything we ship.
  bitRate?: number;
  // Trade quality for first-byte latency. 0 = full quality (default),
  // 1 = optimized. Doesn't change our streaming-vs-blocking model
  // (we still get one binary blob back) but does affect the synth budget.
  optimizeStreamingLatency?: 0 | 1;
  signal?: AbortSignal;
}

export interface XaiTtsResult {
  // Binary audio bytes in the requested codec. For mp3, ready to ship
  // to the browser and decode via decodeAudioData.
  audio: Uint8Array;
  // Echoed back so the WS layer can stamp it on tts_audio if it ever
  // matters. Currently only mp3 ships and the UI doesn't branch on it.
  codec: string;
  // Wall-clock time the synth call took. Useful for the per-turn log.
  synthMs: number;
}

export class XaiTtsClient {
  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error("XaiTtsClient requires an API key — set providers.grok.apiKey or XAI_API_KEY");
    }
  }

  async synthesize(opts: XaiTtsOptions): Promise<XaiTtsResult> {
    const codec = opts.codec ?? "mp3";
    const body: Record<string, unknown> = {
      text: opts.text,
      voice_id: opts.voiceId,
      language: opts.language ?? "en",
      output_format: {
        codec,
        // 24kHz is xAI's default — explicit so the response sample-rate
        // header (if any) doesn't surprise us. mp3 ignores sample_rate
        // (the codec stamps its own); included for symmetry.
        sample_rate: 24000,
        ...(codec === "mp3" ? { bit_rate: opts.bitRate ?? 128000 } : {}),
      },
      optimize_streaming_latency: opts.optimizeStreamingLatency ?? 0,
      // text_normalization defaults to false on xAI's side, matching
      // what we want — we ship sentence-clean text from the chunker and
      // don't need xAI's normalizer rewriting numbers/dates.
      text_normalization: false,
    };

    const started = Date.now();
    const response = await fetch(XAI_TTS_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const errBody = await response.json() as { error?: { message?: string }; message?: string };
        const m = errBody.error?.message ?? errBody.message;
        if (m) detail = `${detail} — ${m}`;
      } catch { /* not json */ }
      throw new Error(`xAI TTS failed: ${detail}`);
    }

    const audio = new Uint8Array(await response.arrayBuffer());
    if (audio.byteLength === 0) {
      throw new Error("xAI TTS returned an empty audio body");
    }
    return {
      audio,
      codec,
      synthMs: Date.now() - started,
    };
  }
}
