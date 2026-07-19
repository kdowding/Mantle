// AudioWorklet processor for realtime call mic capture.
//
// Pulls mic samples from the AudioWorklet input (whatever rate the
// AudioContext gave us — typically 44.1k or 48k), linear-resamples to
// 24kHz, converts to Int16 LE, and emits ~40ms frames (960 samples at
// 24kHz) back to the main thread via port.postMessage.
//
// Linear interpolation is good enough for speech going through an STT
// model — xAI's transcription is robust to it. A polyphase resampler
// would be cleaner but materially more code for no audible benefit.

class RealtimeCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetSampleRate = opts.targetSampleRate || 24000;
    // AudioWorkletGlobalScope exposes `sampleRate` for the current AC.
    this.sourceSampleRate = opts.sourceSampleRate || sampleRate;
    this.frameSize = opts.frameSize || 960;

    // Resample step in source-sample units. e.g. 48000 → 24000 ⇒ step=2.0
    this.step = this.sourceSampleRate / this.targetSampleRate;
    // Position within the input block where the next output sample is read.
    this.inIdx = 0;

    // Output frame accumulator
    this.outBuffer = new Int16Array(this.frameSize);
    this.outIdx = 0;

    // Carry the last sample of the previous block so we can interpolate
    // across the block boundary cleanly.
    this.prevTail = 0;
    this.firstBlock = true;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch || ch.length === 0) return true;

    const blockLen = ch.length;

    // Walk through the input block emitting downsampled samples at `step`.
    while (this.inIdx < blockLen) {
      const i0 = Math.floor(this.inIdx);
      const i1 = i0 + 1;
      const t = this.inIdx - i0;

      const s0 = i0 < 0 ? this.prevTail : ch[i0];
      const s1 = i1 < blockLen ? ch[i1] : ch[blockLen - 1];
      const sample = s0 + (s1 - s0) * t;

      const clamped = sample < -1 ? -1 : (sample > 1 ? 1 : sample);
      this.outBuffer[this.outIdx++] = clamped < 0 ? (clamped * 32768) | 0 : (clamped * 32767) | 0;

      if (this.outIdx >= this.frameSize) {
        // Copy out the filled frame and post it back. .slice() so the
        // main thread doesn't share our internal buffer.
        this.port.postMessage(this.outBuffer.slice(0));
        this.outIdx = 0;
      }

      this.inIdx += this.step;
    }

    // Carry the boundary state for the next block.
    this.prevTail = ch[blockLen - 1];
    this.inIdx -= blockLen;
    this.firstBlock = false;
    return true;
  }
}

registerProcessor('realtime-capture-worklet', RealtimeCaptureProcessor);
