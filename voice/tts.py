"""
TTS engine — chatterbox-streaming wrapper with explicit state machine.

Uses the original 0.5B chatterbox model (not turbo) via davidbrowne17's
streaming fork. The model itself yields audio sub-chunks as it generates
via `generate_stream()`. Phase 1 hides this behind the existing per-chunk
WAV API: we consume the stream internally and concatenate sub-chunks
before responding, so mantle's WS protocol stays unchanged. Phase 2 will
expose the streaming through to the WS layer.

State transitions:
  unloaded → loading → loaded   (happy path)
  unloaded → loading → failed   (load error; engine.error holds the message)
  loaded   → unloading → unloaded   (manual unload to free VRAM)

Concurrency: load/unload serialize through an asyncio.Lock so a burst of
parallel requests (UI toggling, mantle polling) can't double-load. synth()
takes its own per-call lock so the model's internal state can't be
clobbered by interleaved generate_stream calls.

Compared to the previous chatterbox-turbo wrapper, this drops the
cap-hit retry path, the python-side clause-break splitter, and the
silence-trim helper — the streaming model handles long text internally
and applies its own boundary fades.
"""

import asyncio
import io
import logging
import os
import sys
from pathlib import Path
from typing import Literal, Optional

logger = logging.getLogger("voice.tts")

State = Literal["unloaded", "loading", "loaded", "unloading", "failed"]


def _patch_librosa_float32() -> None:
    """librosa returns float64 by default; chatterbox passes those arrays
    into torch.from_numpy() preserving the dtype, which mismatches its
    float32 model weights. Patching at the librosa level covers every
    chatterbox-internal callsite.

    Safe in this process because the voice sidecar is single-purpose —
    nothing else here cares about librosa's output dtype.
    """
    import numpy as np
    import librosa as _lib  # type: ignore

    if getattr(_lib, "_mantle_voice_f32_patched", False):
        return

    _orig_load = _lib.load
    _orig_resample = _lib.resample

    def _load_f32(*args, **kwargs):
        y, sr = _orig_load(*args, **kwargs)
        return y.astype(np.float32), sr

    def _resample_f32(*args, **kwargs):
        return _orig_resample(*args, **kwargs).astype(np.float32)

    _lib.load = _load_f32
    _lib.resample = _resample_f32
    _lib._mantle_voice_f32_patched = True
    logger.info("librosa patched to float32 outputs")


class TTSEngine:
    def __init__(self) -> None:
        self.state: State = "unloaded"
        self.error: Optional[str] = None
        self.sample_rate: int = 24_000  # chatterbox-turbo default; updated on load
        self.device: str = "cuda"
        self._model = None
        # Conditioning cache key. `exaggeration` is baked into the T3Cond
        # by prepare_conditionals (sets emotion_adv); changing it requires
        # re-preparing, so the cache key must include both the ref path
        # and the exaggeration value. Sentinel (-1.0) ensures first call
        # for any agent triggers a prepare.
        self._last_cond_key: tuple = ("", -1.0)
        self._lifecycle_lock = asyncio.Lock()
        self._synth_lock = asyncio.Lock()

    # ── Lifecycle ──────────────────────────────────────────────────────────

    async def load(self, device: Optional[str] = None) -> State:
        async with self._lifecycle_lock:
            if self.state == "loaded":
                return self.state
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
            logger.exception("TTS load failed: %s", exc)

        return self.state

    async def unload(self) -> State:
        async with self._lifecycle_lock:
            if self.state in ("unloaded", "failed"):
                return self.state
            self.state = "unloading"

        try:
            await asyncio.to_thread(self._unload_sync)
            self.state = "unloaded"
            self._last_cond_key = ("", -1.0)
        except Exception as exc:
            self.state = "failed"
            self.error = str(exc)
            logger.exception("TTS unload failed: %s", exc)

        return self.state

    def _load_sync(self) -> None:
        import torch

        if self.device == "cuda":
            if not torch.cuda.is_available():
                logger.warning("CUDA unavailable, falling back to CPU")
                self.device = "cpu"
            else:
                logger.info("CUDA: %s", torch.cuda.get_device_name(0))

        # Windows cuDNN workaround. PyTorch's cuDNN DLL probe can hang on
        # Windows if it picks up an outdated system-level cudnn.dll.
        # Chatterbox is transformer-based — cublas handles attention/matmul
        # so disabling cuDNN has negligible perf impact.
        if self.device == "cuda":
            torch.backends.cudnn.enabled = False
            torch.backends.cudnn.benchmark = False
            logger.info("cuDNN disabled (Windows DLL conflict workaround)")

            if os.name == "nt":
                for p in sys.path:
                    cudnn_bin = os.path.join(p, "nvidia", "cudnn", "bin")
                    if os.path.isdir(cudnn_bin):
                        try:
                            os.add_dll_directory(cudnn_bin)
                            logger.info("Registered cuDNN DLL path: %s", cudnn_bin)
                        except OSError:
                            pass
                        break

        _patch_librosa_float32()

        logger.info("Importing ChatterboxTTS (chatterbox-streaming, original 0.5B)…")
        from chatterbox.tts import ChatterboxTTS  # type: ignore

        logger.info("Loading model on device=%s", self.device)
        self._model = ChatterboxTTS.from_pretrained(device=self.device)
        self.sample_rate = self._model.sr
        logger.info("TTS ready (sr=%d, device=%s)", self.sample_rate, self.device)

    def _unload_sync(self) -> None:
        self._model = None
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    # ── Synthesis ──────────────────────────────────────────────────────────

    async def synthesize_stream(
        self,
        text: str,
        voice_ref_path: str,
        temperature: float = 0.7,
        cfg_weight: float = 0.5,
        exaggeration: float = 0.5,
    ):
        """Async generator yielding (sub_chunk_wav_bytes, meta_dict) per
        sub-chunk emitted by the model. Final yield is (None, final_meta)
        with summary stats — caller uses meta['is_final'] to detect.

        Phase 2 streaming: surfaces the model's internal generate_stream()
        sub-chunks all the way to callers. The TS server emits each as its
        own tts_audio WS event so the browser starts playing audio long
        before the full sentence finishes synthesizing.

        Knobs (chatterbox-streaming exposes only these):
          - temperature : sampling temp (0.5-0.9 typical, default 0.7)
          - cfg_weight  : classifier-free guidance — speaker conditioning
                          strength vs prior. The accent-anchoring knob.
          - exaggeration: emotion intensity baked into the cached T3Cond.

        Sub-chunk meta (per yield):
          {"sub_idx": int, "elapsed_ms": int (from synth start),
           "audio_ms": int, "is_first": bool, "is_final": False}
        Final meta (last yield, audio is None):
          {"is_final": True, "chars": int, "audio_total_ms": int,
           "synth_total_ms": int, "ttfb_ms": int, "num_sub_chunks": int}

        Serializes through self._synth_lock — generate_stream walks the T3
        autoregressive loop, which isn't safe to interleave across calls.
        Bridges the sync generator into async via a thread + queue.
        """
        if self.state != "loaded" or self._model is None:
            raise RuntimeError(f"TTS not loaded (state={self.state})")

        ref = Path(voice_ref_path)
        if not ref.exists():
            raise FileNotFoundError(f"Voice reference not found: {voice_ref_path}")

        import queue as _queue
        import threading

        async with self._synth_lock:
            sentinel = object()
            q: _queue.Queue = _queue.Queue(maxsize=16)
            exc_holder: list = []

            def producer() -> None:
                try:
                    for item in self._stream_iter(
                        text, str(ref), temperature, cfg_weight, exaggeration,
                    ):
                        q.put(item)
                except Exception as exc:  # noqa: BLE001
                    exc_holder.append(exc)
                finally:
                    q.put(sentinel)

            thread = threading.Thread(target=producer, daemon=True)
            thread.start()
            try:
                while True:
                    # Bridge the sync queue into async via to_thread.
                    item = await asyncio.to_thread(q.get)
                    if item is sentinel:
                        if exc_holder:
                            raise exc_holder[0]
                        break
                    yield item
            finally:
                thread.join(timeout=2.0)

    async def synthesize_full(
        self,
        text: str,
        voice_ref_path: str,
        temperature: float = 0.7,
        cfg_weight: float = 0.5,
        exaggeration: float = 0.5,
    ) -> tuple:
        """Non-streaming convenience wrapper: drains synthesize_stream and
        concatenates sub-chunks into a single WAV. Used by the preview
        endpoint where streaming would just complicate things — the tuning
        modal wants one binary WAV to hand to <audio>.

        Returns (wav_bytes, meta) — same shape as the Phase 1 synthesize().
        """
        import numpy as np
        import torch

        sub_audios: list = []
        final_meta: dict | None = None
        async for audio_bytes, meta in self.synthesize_stream(
            text, voice_ref_path, temperature, cfg_weight, exaggeration,
        ):
            if meta.get("is_final"):
                final_meta = meta
                continue
            # Decode the sub-chunk WAV → float32 array → concat at end.
            sub_audios.append(_wav_bytes_to_array(audio_bytes))

        if not sub_audios:
            raise RuntimeError(f"synthesize_stream produced no audio for {len(text)}-char input")

        full_np = np.concatenate(sub_audios)
        full_wav = torch.from_numpy(full_np)
        return _wav_to_bytes(full_wav, self.sample_rate), (final_meta or {})

    def _stream_iter(
        self,
        text: str,
        voice_ref_path: str,
        temperature: float,
        cfg_weight: float,
        exaggeration: float,
    ):
        """Sync generator: runs the model's generate_stream, yields
        (wav_bytes, meta) per sub-chunk plus a final (None, final_meta).

        Each sub-chunk is a complete WAV (with header) so callers can
        decode independently — small per-sub-chunk overhead (~44 bytes
        header) is negligible vs the audio payload.

        Boundary handling:
          - Mid-stream sub-chunks get a 20ms fade-out IF their tail is at
            high amplitude (chunks split at token boundaries, often mid-
            syllable). If the tail is already quiet, fade is skipped to
            avoid an unnecessary amplitude dip that would register as a
            faint stutter at every sub-chunk boundary.
          - The LAST sub-chunk gets buffered until generator end, then
            silence-trimmed (chatterbox-streaming sometimes overshoots
            end-of-speech and emits trailing noise — same root cause as
            turbo's cap-hit problem, just no retry path here). No fade
            applied to its tail since natural sentence-end decay is fine.
        """
        import time
        import numpy as np
        import torch

        m = self._model
        t_start = time.perf_counter()

        # Voice ref preparation is expensive (loads audio, runs voice
        # encoder LSTM, computes embeddings). Cache by (path, exaggeration)
        # because exaggeration is baked into the T3Cond's emotion_adv —
        # changing it requires re-preparing. cfg_weight applies at runtime
        # per-call, not in the cached conditional.
        cond_key = (voice_ref_path, exaggeration)
        if cond_key != self._last_cond_key:
            m.prepare_conditionals(voice_ref_path, exaggeration=exaggeration)
            self._last_cond_key = cond_key

        ttfb_ms: int | None = None
        # Buffer the previous sub-chunk so we can detect "this is the last
        # one" by waiting for the generator to either yield another (then
        # the held one was NOT last → emit it normally) or end (then it
        # WAS last → trim + emit without fade).
        pending_audio: "np.ndarray | None" = None
        pending_meta: dict | None = None
        emitted = 0

        def _emit_held(is_last: bool):
            """Emit the buffered sub-chunk. is_last gates trim + fade behavior
            AND surfaces is_last in the meta so the TS server knows to set
            the inter-sentence pacing cue (pacingChar) on the WS event."""
            nonlocal emitted
            if pending_audio is None or pending_meta is None:
                return None
            audio = pending_audio
            if is_last:
                # Compute the remaining audio budget from text length,
                # subtracting what's already been emitted in earlier
                # sub-chunks. The trim hard-caps to this budget, which
                # catches speech-like model overshoot (sighs/yawns/
                # elongated tails) that the silence-threshold trim alone
                # leaves alone. Floor the remaining budget at 100ms to
                # avoid trimming legitimate speech to nothing if the
                # estimate is off.
                expected_total_seconds = max(
                    _END_TRIM_MIN_AUDIO_S,
                    len(text) / _END_TRIM_MAX_CHARS_PER_SEC * _END_TRIM_HEADROOM,
                )
                expected_total_samples = int(expected_total_seconds * self.sample_rate)
                already_emitted_samples = total_audio_samples
                remaining_samples = max(
                    int(0.1 * self.sample_rate),
                    expected_total_samples - already_emitted_samples,
                )
                audio = _trim_trailing_silence(audio, self.sample_rate, max_samples=remaining_samples)
                # No fade-out on the last sub-chunk — natural sentence-end
                # decay sounds better than a hard fade at the trim point.
            else:
                audio = _maybe_fade_out_tail(audio, self.sample_rate)
            wav_bytes = _wav_to_bytes(torch.from_numpy(audio), self.sample_rate)
            n_samples = audio.shape[-1]
            meta_out = dict(pending_meta)
            meta_out["audio_ms"] = int(n_samples / float(self.sample_rate) * 1000)
            meta_out["is_last"] = is_last
            emitted += 1
            return wav_bytes, meta_out, n_samples

        total_audio_samples = 0

        for output in m.generate_stream(
            text,
            cfg_weight=cfg_weight,
            exaggeration=exaggeration,
            temperature=temperature,
            chunk_size=_STREAMING_CHUNK_SIZE,
            context_window=_STREAMING_CONTEXT_WINDOW,
            fade_duration=_STREAMING_FADE_DURATION,
            print_metrics=False,
        ):
            elapsed_ms = int((time.perf_counter() - t_start) * 1000)
            if ttfb_ms is None:
                ttfb_ms = elapsed_ms

            if isinstance(output, tuple) and len(output) == 2:
                audio_t, _metrics = output
            else:
                audio_t = output

            audio_np = audio_t.cpu().numpy() if hasattr(audio_t, "cpu") else audio_t
            if audio_np.ndim > 1:
                audio_np = audio_np.squeeze()
            audio_np = audio_np.astype("float32")

            # Drain held sub-chunk first — confirmed not last because we
            # have a new one. Apply mid-stream fade behavior (conditional).
            if pending_audio is not None:
                emit = _emit_held(is_last=False)
                if emit is not None:
                    wav_bytes, meta_out, n_samples = emit
                    total_audio_samples += n_samples
                    yield wav_bytes, meta_out

            # Hold this sub-chunk back as the new candidate-for-last.
            pending_audio = audio_np
            pending_meta = {
                "sub_idx": emitted,
                "elapsed_ms": elapsed_ms,
                "is_first": emitted == 0,
                "is_final": False,
            }

        # Generator ended — drain the held sub-chunk as the LAST one
        # (silence-trimmed, no fade).
        if pending_audio is not None:
            emit = _emit_held(is_last=True)
            if emit is not None:
                wav_bytes, meta_out, n_samples = emit
                total_audio_samples += n_samples
                yield wav_bytes, meta_out

        synth_total_ms = int((time.perf_counter() - t_start) * 1000)
        audio_total_ms = int(total_audio_samples / float(self.sample_rate) * 1000)
        rtf = synth_total_ms / max(1, audio_total_ms)
        logger.info(
            "synth-stream %dchars → %.2fs audio · synth=%dms ttfb=%dms RTF=%.3f · %d sub-chunks (cfg=%.2f exag=%.2f temp=%.2f)",
            len(text), audio_total_ms / 1000.0, synth_total_ms,
            ttfb_ms or 0, rtf, emitted, cfg_weight, exaggeration, temperature,
        )
        # Final sentinel: audio=None, is_final=True with summary stats
        yield None, {
            "is_final": True,
            "chars": len(text),
            "audio_total_ms": audio_total_ms,
            "synth_total_ms": synth_total_ms,
            "ttfb_ms": ttfb_ms,
            "num_sub_chunks": emitted,
        }


# Fade-out applied to mid-stream sub-chunk tails. Mirrors the model's
# fade-IN symmetrically. Bumped to match _STREAMING_FADE_DURATION below
# so both sides of each sub-chunk transition are equally gentle.
_FADE_DURATION_S = 0.04

# chatterbox-streaming generate_stream tunables. Bumped from defaults to
# trade some TTFB for smoother playback:
#   - chunk_size 25 → 50: each sub-chunk is ~2s of audio (was ~1s).
#     Halves the number of sub-chunk boundaries → halves stutter
#     opportunities. TTFB doubles to ~2s but still much better than
#     turbo's ~10s of full-chunk synth.
#   - context_window 50 → 80: model uses more prior token context per
#     chunk. Smoother continuity at boundaries (model "remembers" more
#     of the prior phonemes). Diminishing returns past ~100.
#   - fade_duration 0.02 → 0.04: model's internal fade-IN at chunk start
#     is gentler. Combined with our matching fade-OUT, total transition
#     is ~80ms — gradual enough to be inaudible, sharp enough not to
#     warble.
_STREAMING_CHUNK_SIZE = 50
_STREAMING_CONTEXT_WINDOW = 120
_STREAMING_FADE_DURATION = 0.04

# Trailing-silence-trim params for the LAST sub-chunk only. Mid-stream
# sub-chunks aren't trimmed — their "trailing silence" might be a real
# mid-syllable breath. Only the model's overshoot at end-of-speech (when
# it fails to emit the stop-speech token cleanly) needs trimming.
_END_TRIM_THRESHOLD = 0.012     # ~ -38 dBFS; below voiced-speech energy
_END_TRIM_TAIL_PAD_MS = 70      # cushion so natural sentence-end decay survives

# Hard cap on audio duration based on text length. Catches model
# overshoot that produces SPEECH-LIKE garbage (sighs, yawns, elongated
# nonsense at sentence end) — these stay above the silence threshold so
# the moving-RMS trim alone keeps them.
#
#   max_seconds = max(min_audio_s, chars / max_chars_per_sec * headroom)
#
# Calibrated against observed user data: normal speech is 14-17 chars/sec
# in production. Anything below ~12-13 chars/sec is suspect. At 14 chars/sec
# * 1.10 headroom, the effective allowed minimum rate is ~12.7 chars/sec
# — still permissive enough not to clip legitimate slow delivery, but
# tight enough to chop multi-second hallucinated tails off the end
# (including the worst case where the model produces brief loud screams
# / yawns that the silence trim alone keeps).
#
# Tighten further (lower max_chars_per_sec or smaller headroom) if model
# overshoot persists; loosen if you hear legitimate speech getting clipped.
_END_TRIM_MAX_CHARS_PER_SEC = 14
_END_TRIM_HEADROOM = 1.10
_END_TRIM_MIN_AUDIO_S = 1.5


def _maybe_fade_out_tail(audio, sample_rate: int):
    """Apply a 20ms linear fade-out to the chunk tail. Always applied —
    even quiet tails benefit because Web Audio's per-buffer scheduling
    introduces JS-level gaps between sub-chunks (handoff via onended →
    setTimeout → start), and the fade smooths the abruptness around
    those gaps."""
    import numpy as np
    fade_samples = int(_FADE_DURATION_S * sample_rate)
    if fade_samples == 0 or audio.shape[-1] <= fade_samples:
        return audio
    out = audio.copy()
    fade_out = np.linspace(1.0, 0.0, fade_samples, dtype=audio.dtype)
    out[-fade_samples:] *= fade_out
    return out


def _trim_trailing_silence(audio, sample_rate: int, max_samples: int | None = None):
    """Trim trailing low-energy tail AND optionally hard-cap to max_samples.

    Two complementary mechanisms applied to the LAST sub-chunk only:

    1. **Moving-RMS silence trim**: sweep from the end backwards via a
       40ms RMS window, find the last window above the speech-energy
       threshold, trim everything after (plus a 70ms cushion for natural
       decay). Catches actual silence/quiet noise after speech ends.

    2. **Hard cap (max_samples)**: catches the harder case where the
       model overshoots end-of-speech and produces SPEECH-LIKE garbage
       (sighs, yawns, elongated sounds) that stays above the silence
       threshold. Caller computes max_samples from a remaining-budget
       calculation (expected_total_audio - already_emitted_audio).
       When None, no cap applied.

    The final trim point is min(silence_end, max_samples) — whichever
    is tighter wins. Pure-silence inputs pass through unchanged.
    """
    import numpy as np
    n = audio.shape[-1]
    if n == 0:
        return audio

    # 1) Silence-trim point via moving RMS.
    window_samples = max(1, int(sample_rate * 0.040))  # 40ms RMS window
    if window_samples >= n:
        above = np.where(np.abs(audio) > _END_TRIM_THRESHOLD)[0]
        if above.size == 0:
            silence_end = n
        else:
            last_idx = int(above[-1])
            tail_pad = max(1, int(sample_rate * _END_TRIM_TAIL_PAD_MS / 1000))
            silence_end = min(n, last_idx + tail_pad + 1)
    else:
        sq = audio.astype(np.float64) ** 2
        csum = np.concatenate(([0.0], np.cumsum(sq)))
        win_sum = csum[window_samples:] - csum[:-window_samples]
        win_rms = np.sqrt(win_sum / window_samples)
        above = np.where(win_rms > _END_TRIM_THRESHOLD)[0]
        if above.size == 0:
            silence_end = n
        else:
            last_speech_end = int(above[-1]) + window_samples
            tail_pad = max(1, int(sample_rate * _END_TRIM_TAIL_PAD_MS / 1000))
            silence_end = min(n, last_speech_end + tail_pad)

    # 2) Hard cap from caller-supplied remaining budget.
    cap_end = max_samples if max_samples is not None else n
    end = min(silence_end, cap_end)

    if end < n and end == cap_end and cap_end < silence_end:
        # Cap bit (audio was longer than the budget). Log so we can spot
        # model overshoots in the per-turn telemetry.
        capped_ms = int((n - end) / sample_rate * 1000)
        logger.info(
            "trim: hard-capped %dms past remaining budget (audio=%dms, cap=%dms)",
            capped_ms,
            int(n / sample_rate * 1000),
            int(end / sample_rate * 1000),
        )
    return audio[:end]


def _wav_to_bytes(wav, sample_rate: int) -> bytes:
    """Encode a 1D wav tensor as WAV file bytes via torchaudio."""
    import torchaudio as ta  # type: ignore
    buf = io.BytesIO()
    ta.save(buf, wav.unsqueeze(0), sample_rate, format="wav")
    buf.seek(0)
    return buf.read()


def _wav_bytes_to_array(wav_bytes: bytes):
    """Decode WAV bytes back into a 1D float32 numpy array. Used by
    synthesize_full to concat sub-chunks into a single playable WAV."""
    import io
    import soundfile as sf
    audio, _sr = sf.read(io.BytesIO(wav_bytes), dtype="float32")
    if audio.ndim > 1:
        audio = audio[:, 0]
    return audio


# Module-level singleton — the FastAPI app holds a reference and never
# instantiates more than one. Singleton is fine because model state (loaded
# weights, voice ref cache) is genuinely process-global.
tts_engine = TTSEngine()
