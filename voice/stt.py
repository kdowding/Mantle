"""
STT engine — faster-whisper wrapper with explicit state machine.

Loaded by /voice/load alongside TTS so the VAD milestone (Phase 2) has
zero load wait when toggled. Phase 1 exposes no transcription endpoint —
this module exists to warm the model into VRAM and validate the install.

Same state machine and lock pattern as tts.py.
"""

import asyncio
import logging
from typing import Literal, Optional

logger = logging.getLogger("voice.stt")

State = Literal["unloaded", "loading", "loaded", "unloading", "failed"]

# Default model. large-v3-turbo is the best quality/latency tradeoff at
# the time of writing — comparable accuracy to large-v3, ~4x faster.
DEFAULT_MODEL = "large-v3-turbo"

# Per-segment confidence thresholds for hallucination filtering. Match
# upstream openai-whisper's silence-detection defaults so we don't drop
# real-but-quiet speech. Tighter thresholds (e.g. no_speech 0.4) start
# eating legitimate short utterances.
_NO_SPEECH_THRESHOLD = 0.6
_LOG_PROB_THRESHOLD = -1.0


class STTEngine:
    def __init__(self) -> None:
        self.state: State = "unloaded"
        self.error: Optional[str] = None
        self.device: str = "cuda"
        self.compute_type: str = "float16"
        self.model_name: str = DEFAULT_MODEL
        self._model = None
        self._lifecycle_lock = asyncio.Lock()
        self._inference_lock = asyncio.Lock()

    async def load(
        self,
        model: Optional[str] = None,
        device: Optional[str] = None,
    ) -> State:
        async with self._lifecycle_lock:
            if self.state == "loaded":
                return self.state
            if model:
                self.model_name = model
            if device:
                self.device = device
            self.state = "loading"
            self.error = None

        try:
            await asyncio.to_thread(self._load_sync)
            self.state = "loaded"
        except Exception as exc:
            self.state = "failed"
            self.error = str(exc)
            logger.exception("STT load failed: %s", exc)

        return self.state

    async def unload(self) -> State:
        async with self._lifecycle_lock:
            if self.state in ("unloaded", "failed"):
                return self.state
            self.state = "unloading"

        try:
            await asyncio.to_thread(self._unload_sync)
            self.state = "unloaded"
        except Exception as exc:
            self.state = "failed"
            self.error = str(exc)
            logger.exception("STT unload failed: %s", exc)

        return self.state

    def _load_sync(self) -> None:
        import torch
        from faster_whisper import WhisperModel  # type: ignore

        if self.device == "cuda" and not torch.cuda.is_available():
            logger.warning("CUDA unavailable, falling back to CPU int8")
            self.device = "cpu"
            self.compute_type = "int8"

        logger.info(
            "Loading Whisper model=%s device=%s compute_type=%s",
            self.model_name, self.device, self.compute_type,
        )
        self._model = WhisperModel(
            self.model_name,
            device=self.device,
            compute_type=self.compute_type,
        )

        # Warmup: run inference on 0.5s of silence so JIT-compiled CUDA
        # kernels are ready before the first real request. Eliminates the
        # cold-start latency spike on user's first utterance.
        import numpy as np
        warmup_audio = np.zeros(8000, dtype=np.float32)
        list(self._model.transcribe(warmup_audio, beam_size=1)[0])

        logger.info("STT ready (model=%s, device=%s)", self.model_name, self.device)

    def _unload_sync(self) -> None:
        self._model = None
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    async def transcribe(
        self,
        audio_bytes: bytes,
        language: Optional[str] = None,
    ) -> dict:
        """Transcribe one complete utterance from WAV bytes.

        Caller has already endpointed (browser-side Silero VAD); we don't
        apply Whisper's vad_filter to avoid trimming leading/trailing words.
        Single-utterance mode: no previous-text conditioning, deterministic
        temperature so identical audio produces identical transcripts.
        """
        if self.state != "loaded":
            raise RuntimeError(f"STT not loaded (state={self.state})")
        async with self._inference_lock:
            return await asyncio.to_thread(self._transcribe_sync, audio_bytes, language)

    def _transcribe_sync(self, audio_bytes: bytes, language: Optional[str]) -> dict:
        import io
        import time
        t0 = time.time()
        bio = io.BytesIO(audio_bytes)
        # faster-whisper accepts a file-like and decodes via av/ffmpeg under
        # the hood, so 48kHz stereo from the browser gets resampled to mono
        # 16kHz internally — no client-side conversion needed.
        segments_iter, info = self._model.transcribe(
            bio,
            beam_size=5,
            language=language,            # None → auto-detect
            vad_filter=False,             # browser already VAD'd; don't double up
            condition_on_previous_text=False,
            temperature=0.0,
        )

        # Filter likely non-speech / hallucinated segments. Whisper is famous
        # for emitting "Thank you.", "Bye!", or repeats on near-silence audio
        # (e.g. user paused mid-thought, or Silero misfired on background noise).
        # `no_speech_prob` and `avg_logprob` are the model's own confidence
        # signals; thresholds match upstream openai-whisper's silence-detect
        # defaults — conservative enough not to drop quiet real speech.
        kept = []
        dropped = 0
        for seg in segments_iter:
            if seg.no_speech_prob > _NO_SPEECH_THRESHOLD:
                dropped += 1
                continue
            if seg.avg_logprob < _LOG_PROB_THRESHOLD:
                dropped += 1
                continue
            kept.append(seg)
        text = " ".join(seg.text.strip() for seg in kept).strip()
        if dropped:
            logger.info(
                "transcribe: dropped %d/%d segments as likely non-speech (final=%r)",
                dropped, dropped + len(kept), text[:60],
            )
        return {
            "text": text,
            "language": info.language,
            "language_probability": info.language_probability,
            "audio_duration_s": info.duration,
            "inference_ms": int((time.time() - t0) * 1000),
        }

    async def transcribe_path(
        self,
        path: str,
        language: Optional[str] = None,
    ) -> dict:
        """Transcribe a full audio FILE (e.g. a song mp3) WITH word-level
        timestamps — the karaoke path. Reads from disk (faster-whisper decodes
        mp3 via av/ffmpeg, no pre-conversion needed), keeps the same
        hallucination filter as the mic path so instrumental gaps don't spawn
        phantom lines, and returns per-segment + per-word timing for synced
        display."""
        if self.state != "loaded":
            raise RuntimeError(f"STT not loaded (state={self.state})")
        async with self._inference_lock:
            return await asyncio.to_thread(self._transcribe_path_sync, path, language)

    def _transcribe_path_sync(self, path: str, language: Optional[str]) -> dict:
        import time
        t0 = time.time()
        segments_iter, info = self._model.transcribe(
            path,
            beam_size=5,
            language=language,            # None → auto-detect
            vad_filter=False,
            condition_on_previous_text=False,
            temperature=0.0,
            word_timestamps=True,
        )
        kept = []
        dropped = 0
        for seg in segments_iter:
            if seg.no_speech_prob > _NO_SPEECH_THRESHOLD or seg.avg_logprob < _LOG_PROB_THRESHOLD:
                dropped += 1
                continue
            words = []
            for w in (seg.words or []):
                if w.start is None or w.end is None:
                    continue
                words.append({
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                    "word": w.word,
                    "probability": round(w.probability or 0.0, 4),
                })
            kept.append({
                "start": round(seg.start, 3),
                "end": round(seg.end, 3),
                "text": seg.text.strip(),
                "words": words,
            })
        text = " ".join(s["text"] for s in kept).strip()
        if dropped:
            logger.info(
                "transcribe_path: dropped %d/%d segments as likely non-speech",
                dropped, dropped + len(kept),
            )
        return {
            "text": text,
            "language": info.language,
            "language_probability": info.language_probability,
            "audio_duration_s": info.duration,
            "inference_ms": int((time.time() - t0) * 1000),
            "segments": kept,
        }


stt_engine = STTEngine()
