"""
MANTLE voice sidecar — FastAPI HTTP service.

Spawned eagerly on `mantle start` (cheap idle process). Models lazy-load on
POST /voice/load so VRAM isn't committed until the user toggles voice mode.

Endpoints:
  GET  /health                   — liveness probe for the manager
  GET  /voice/status             — current model state + sample rate
  POST /voice/load               — fire-and-forget model warm (returns immediately)
  POST /voice/unload             — fire-and-forget model unload (frees VRAM)
  POST /voice/tts/synthesize     — synth one chunk of text → audio/wav

Run standalone for testing:
  .venv/Scripts/python.exe -m voice.server

The mantle harness spawns this same way via src/voice/manager.ts.
"""

import asyncio
import base64
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .normalizer import normalize_for_tts
from .stt import stt_engine
from .tts import tts_engine

logging.basicConfig(
    level=logging.INFO,
    format="[voice:%(name)s] %(message)s",
)
logger = logging.getLogger("server")


# ── Lifespan ───────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("voice sidecar started (models unloaded — load via POST /voice/load)")
    yield
    logger.info("voice sidecar shutting down — unloading models")
    await asyncio.gather(
        tts_engine.unload(),
        stt_engine.unload(),
        return_exceptions=True,
    )


app = FastAPI(title="MANTLE voice sidecar", lifespan=lifespan)


# ── Request/response models ────────────────────────────────────────────────

class LoadRequest(BaseModel):
    tts: bool = True
    # STT default off — Phase 2 mantle doesn't ship mic-in yet, so loading
    # faster-whisper just steals VRAM from TTS without serving a real use
    # case. Callers can opt in explicitly by passing stt=true. (When
    # mic-in / barge-in lands, flip this back or have mantle's TS-side
    # always send stt=true alongside the user enabling mic mode.)
    stt: bool = False


class StatusResponse(BaseModel):
    tts: str
    stt: str
    tts_error: Optional[str] = None
    stt_error: Optional[str] = None
    sample_rate: int
    tts_device: str
    stt_device: str


class SynthRequest(BaseModel):
    text: str = Field(..., description="Pre-chunked sentence(s) to synthesize")
    voice_ref: str = Field(..., description="Absolute path to reference .wav file")
    # chatterbox-streaming's generate_stream API exposes a leaner knob set
    # than turbo's inference_turbo did. top_k / top_p / repetition_penalty
    # / cfm_timesteps are NOT runtime-tunable on the streaming path —
    # they're baked into the underlying generator with sensible defaults.
    temperature: float = 0.7
    # 1.0 = full speaker fidelity. Empirically the most reliable default
    # — high CFG suppresses both accent drift (model prior leaks at low
    # CFG) and the hallucinated sigh/yawn/scream tails the model
    # otherwise produces with low-CFG freedom. Mantle's TS layer always
    # passes an explicit value, so this is just the bare-curl fallback.
    cfg_weight: float = 1.0
    exaggeration: float = 0.5  # emotion intensity, baked into cached T3Cond
    skip_normalize: bool = Field(
        False,
        description="Skip the text normalizer (only when caller has already cleaned the text)",
    )


# ── Routes ─────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict:
    return {"ok": True}


@app.get("/voice/status", response_model=StatusResponse)
async def status() -> StatusResponse:
    return StatusResponse(
        tts=tts_engine.state,
        stt=stt_engine.state,
        tts_error=tts_engine.error,
        stt_error=stt_engine.error,
        sample_rate=tts_engine.sample_rate,
        tts_device=tts_engine.device,
        stt_device=stt_engine.device,
    )


@app.post("/voice/load", response_model=StatusResponse)
async def load(body: LoadRequest = LoadRequest()) -> StatusResponse:
    """Kick off model loading in the background and return immediately.

    Caller polls GET /voice/status to detect transitions (loading → loaded
    or loading → failed). Idempotent: if a model is already loaded or
    loading, the call is a no-op for that engine.

    Loads are SERIALIZED (TTS then STT) — not parallel. transformers v5's
    lazy `_LazyModule` system races when accessed from concurrent threads,
    and both chatterbox and faster-whisper reach into transformers during
    import. Parallel loads reproducibly fail with a misleading
    "cannot import name 'LlamaModel'" ImportError. Sequential loads cost
    a few extra seconds at toggle-time and are bulletproof.
    """
    async def _load_sequence() -> None:
        if body.tts and tts_engine.state in ("unloaded", "failed"):
            await tts_engine.load()
        if body.stt and stt_engine.state in ("unloaded", "failed"):
            await stt_engine.load()

    asyncio.create_task(_load_sequence())

    # Tiny yield so the just-scheduled task transitions TTS state from
    # "unloaded" → "loading" before we read it for the response.
    await asyncio.sleep(0)

    return await status()


@app.post("/voice/unload", response_model=StatusResponse)
async def unload(body: LoadRequest = LoadRequest()) -> StatusResponse:
    """Kick off model unload (frees VRAM) and return immediately."""
    if body.tts and tts_engine.state == "loaded":
        asyncio.create_task(tts_engine.unload())
    if body.stt and stt_engine.state == "loaded":
        asyncio.create_task(stt_engine.unload())

    await asyncio.sleep(0)
    return await status()


@app.post("/voice/tts/synthesize")
async def synthesize(body: SynthRequest) -> StreamingResponse:
    """Stream synthesis of one chunk as NDJSON. Each line is one event:

      {"sub_idx": int, "elapsed_ms": int, "audio_ms": int,
       "is_first": bool, "audio_b64": str, "sample_rate": int}

    The last line is the final marker (no audio):
      {"is_final": true, "chars": int, "audio_total_ms": int,
       "synth_total_ms": int, "ttfb_ms": int, "num_sub_chunks": int}

    Errors land as a single line:
      {"is_final": true, "error": str}

    Mid-stream chunking happens on the mantle side (TypeScript watching
    LLM text deltas), so each call is one already-bounded chunk. Caller
    is expected to have run normalize_for_tts() OR set skip_normalize=true.
    """
    if tts_engine.state != "loaded":
        raise HTTPException(
            status_code=409,
            detail=f"TTS not loaded (state={tts_engine.state}). POST /voice/load first.",
        )

    text = body.text if body.skip_normalize else normalize_for_tts(body.text)
    if not text or not text.strip():
        raise HTTPException(status_code=400, detail="Empty text after normalization")

    sample_rate = tts_engine.sample_rate

    async def stream_lines():
        try:
            async for audio_bytes, meta in tts_engine.synthesize_stream(
                text=text,
                voice_ref_path=body.voice_ref,
                temperature=body.temperature,
                cfg_weight=body.cfg_weight,
                exaggeration=body.exaggeration,
            ):
                line: dict = dict(meta)
                if audio_bytes is not None:
                    line["audio_b64"] = base64.b64encode(audio_bytes).decode("ascii")
                    line["sample_rate"] = sample_rate
                yield (json.dumps(line) + "\n").encode("utf-8")
        except FileNotFoundError as exc:
            yield (json.dumps({"is_final": True, "error": str(exc)}) + "\n").encode("utf-8")
        except Exception as exc:
            logger.exception("synthesize stream failed: %s", exc)
            yield (json.dumps({"is_final": True, "error": str(exc)}) + "\n").encode("utf-8")

    debug_text = text[:200].encode("ascii", errors="replace").decode("ascii")
    return StreamingResponse(
        stream_lines(),
        media_type="application/x-ndjson",
        headers={
            "X-Sample-Rate": str(sample_rate),
            "X-Normalized-Text": debug_text,
            # Disable proxy buffering so each NDJSON line ships ASAP.
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
        },
    )


@app.post("/voice/tts/preview")
async def synthesize_preview(body: SynthRequest) -> Response:
    """Non-streaming synthesis — returns one binary WAV. Used by the
    voice tuning modal where streaming is overkill (the modal just hands
    the result to a browser <audio> element)."""
    if tts_engine.state != "loaded":
        raise HTTPException(
            status_code=409,
            detail=f"TTS not loaded (state={tts_engine.state}). POST /voice/load first.",
        )

    text = body.text if body.skip_normalize else normalize_for_tts(body.text)
    if not text or not text.strip():
        raise HTTPException(status_code=400, detail="Empty text after normalization")

    try:
        wav, _meta = await tts_engine.synthesize_full(
            text=text,
            voice_ref_path=body.voice_ref,
            temperature=body.temperature,
            cfg_weight=body.cfg_weight,
            exaggeration=body.exaggeration,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.exception("preview synth failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))

    debug_text = text[:200].encode("ascii", errors="replace").decode("ascii")
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={
            "X-Sample-Rate": str(tts_engine.sample_rate),
            "X-Normalized-Text": debug_text,
        },
    )


@app.post("/voice/stt/transcribe")
async def transcribe(request: Request, language: Optional[str] = None) -> dict:
    """Transcribe one complete utterance → returns {text, language, ...}.

    Body is raw WAV bytes (Content-Type: audio/wav). Browser is expected to
    have endpointed via Silero VAD before calling — Whisper's own vad_filter
    is intentionally disabled on this path so we don't trim the user's
    leading/trailing words.

    Optional ?language=en query param skips Whisper's auto-detect (saves
    ~50-100ms on short utterances). Auto-detect by default.
    """
    if stt_engine.state != "loaded":
        raise HTTPException(
            status_code=409,
            detail=f"STT not loaded (state={stt_engine.state}). POST /voice/load first.",
        )
    audio_bytes = await request.body()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty body — expected WAV bytes")

    try:
        return await stt_engine.transcribe(audio_bytes, language=language)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        logger.exception("transcribe failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


class TranscribeSongRequest(BaseModel):
    path: str
    language: Optional[str] = None


@app.post("/voice/stt/transcribe_song")
async def transcribe_song(body: TranscribeSongRequest) -> dict:
    """Transcribe a full audio file from disk WITH word timestamps (the
    karaoke path). `path` is supplied by mantle over loopback (shared
    filesystem) and has already been traversal-guarded under the music root.
    Returns {text, language, segments:[{start,end,text,words:[...]}], ...}."""
    if stt_engine.state != "loaded":
        raise HTTPException(
            status_code=409,
            detail=f"STT not loaded (state={stt_engine.state}). POST /voice/load first.",
        )
    if not body.path or not os.path.isfile(body.path):
        raise HTTPException(status_code=404, detail=f"Audio file not found: {body.path}")
    try:
        return await stt_engine.transcribe_path(body.path, language=body.language)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        logger.exception("transcribe_song failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ── Entry point ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("MANTLE_VOICE_PORT", "7333"))
    host = os.environ.get("MANTLE_VOICE_HOST", "127.0.0.1")
    uvicorn.run(
        "voice.server:app",
        host=host,
        port=port,
        log_level="info",
        access_log=False,  # quiet in mantle's combined logs
    )
