// Voice routes — a thin pass-through to the Python voice sidecar via
// VoiceManager's client: status (+ a per-agent voice-file availability
// map), TTS/STT model load/unload, Whisper transcribe, a synth preview
// for the tuning UI, and per-agent voice config. Peeled out of api.ts;
// handleApi delegates here for any /api/voice/* path.

import type { MantleConfig } from "../config/schema.js";
import type { VoiceManager } from "../voice/manager.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleVoiceApi(
  req: Request,
  url: URL,
  config: MantleConfig,
  voiceManager?: VoiceManager,
): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  if (!voiceManager || !voiceManager.isEnabled()) {
    return json({ error: "Voice features disabled (config.voice.enabled=false)" }, 503);
  }
  if (!voiceManager.isAlive()) {
    return json({ error: "Voice sidecar is not running. Check mantle logs for spawn errors." }, 503);
  }
  const client = voiceManager.getClient();

  if (path === "/api/voice/status" && method === "GET") {
    try {
      const status = await client.status();
      const voices: Record<string, boolean> = {};
      const selectedVoices: Record<string, string | null> = {};
      for (const a of config.agents) {
        voices[a.id] = voiceManager.resolveVoiceRef(a.id, a.voiceFile) !== null;
        selectedVoices[a.id] = a.voiceFile ?? null;
      }
      const availableVoices = voiceManager.listAvailableVoices();
      return json({ ...status, voices, selectedVoices, availableVoices });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  if (path === "/api/voice/load" && method === "POST") {
    try {
      const body = req.headers.get("content-type")?.includes("application/json")
        ? (await req.json().catch(() => ({}))) as { tts?: boolean; stt?: boolean }
        : {};
      const status = await client.load(body);
      return json(status);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  if (path === "/api/voice/unload" && method === "POST") {
    try {
      const body = req.headers.get("content-type")?.includes("application/json")
        ? (await req.json().catch(() => ({}))) as { tts?: boolean; stt?: boolean }
        : {};
      const status = await client.unload(body);
      return json(status);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  // POST /api/voice/transcribe — browser → mantle → sidecar Whisper.
  // Raw WAV bytes in the body (Content-Type: audio/wav). The browser is
  // expected to have endpointed via Silero VAD, so we don't apply
  // Whisper's vad_filter on the sidecar side. Optional ?language= passes
  // through to skip auto-detect.
  if (path === "/api/voice/transcribe" && method === "POST") {
    try {
      // Cap the body so a runaway/malicious client can't OOM the process —
      // every other binary-ingest path enforces a ceiling; this one didn't.
      // ~25MB ≈ 13 min of 16kHz mono WAV, far beyond any VAD-endpointed clip.
      const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;
      const declaredLen = Number(req.headers.get("content-length") ?? "");
      if (Number.isFinite(declaredLen) && declaredLen > MAX_TRANSCRIBE_BYTES) {
        return json({ error: "Audio too large" }, 413);
      }
      const buf = await req.arrayBuffer();
      if (buf.byteLength === 0) {
        return json({ error: "Empty body — expected WAV bytes" }, 400);
      }
      if (buf.byteLength > MAX_TRANSCRIBE_BYTES) {
        return json({ error: "Audio too large" }, 413);
      }
      const language = url.searchParams.get("language") ?? undefined;
      const result = await client.transcribe({ audio: new Uint8Array(buf), language });
      return json(result);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  // POST /api/voice/preview — synthesize a sample with provided params,
  // returns audio/wav. Doesn't persist anything; used by the voice
  // tuning UI to A/B settings before saving them. Body:
  //   { agentId, sample, params: { temperature?, topK?, topP?,
  //     repetitionPenalty?, cfmTimesteps? } }
  // Missing params fall through to global defaults (NOT the agent's
  // currently-saved overrides — preview shows what the SLIDER values
  // would sound like, not the merged result).
  if (path === "/api/voice/preview" && method === "POST") {
    let body: {
      agentId?: string;
      sample?: string;
      params?: Partial<{ temperature: number; cfgWeight: number; exaggeration: number }>;
    };
    try {
      body = await req.json() as typeof body;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const agentId = body.agentId?.trim();
    if (!agentId) return json({ error: "agentId is required" }, 400);
    const agent = config.agents.find((a) => a.id === agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);
    const voiceRef = voiceManager.resolveVoiceRef(agentId, agent.voiceFile);
    if (!voiceRef) return json({ error: `No voice file for agent (voices/${agent.voiceFile ?? agentId + '.wav'})` }, 404);
    const sample = (body.sample ?? "").trim();
    if (!sample) return json({ error: "sample text is required" }, 400);

    const baseDefaults = config.voice.defaults;
    const p = body.params ?? {};
    try {
      const result = await client.synthesizePreview({
        text: sample,
        voiceRef,
        temperature: p.temperature ?? baseDefaults.temperature,
        cfgWeight: p.cfgWeight ?? baseDefaults.cfgWeight,
        exaggeration: p.exaggeration ?? baseDefaults.exaggeration,
      });
      return new Response(result.audio.buffer as ArrayBuffer, {
        status: 200,
        headers: {
          "Content-Type": "audio/wav",
          "X-Sample-Rate": String(result.sampleRate),
        },
      });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  // GET /api/voice/agent/:id — return current voice config for an agent:
  // the global defaults + the agent's overrides (if any). UI uses this
  // to populate the tuning modal sliders.
  const voiceAgentMatch = path.match(/^\/api\/voice\/agent\/([\w-]+)$/);
  if (voiceAgentMatch && method === "GET") {
    const agentId = voiceAgentMatch[1];
    const agent = config.agents.find((a) => a.id === agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);
    return json({
      agentId,
      defaults: config.voice.defaults,
      overrides: agent.voice ?? {},
    });
  }

  return json({ error: `Unknown voice route: ${method} ${path}` }, 404);
}
