// Float32Array (mono PCM, any sample rate) → 16-bit WAV file bytes. Ported
// from ui/wav-encoder.js — packs what Silero VAD hands us (16kHz mono
// Float32) into a WAV the sidecar's Whisper pipeline can decode. Kept tiny
// and allocation-light because it runs on every utterance.

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);

  let off = 0;
  const writeStr = (s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off++, s.charCodeAt(i));
  };

  // RIFF header
  writeStr('RIFF');
  view.setUint32(off, 36 + dataSize, true); off += 4;
  writeStr('WAVE');

  // fmt subchunk (PCM)
  writeStr('fmt ');
  view.setUint32(off, 16, true);            off += 4; // subchunk size
  view.setUint16(off, 1, true);             off += 2; // audio format = PCM
  view.setUint16(off, numChannels, true);   off += 2;
  view.setUint32(off, sampleRate, true);    off += 4;
  view.setUint32(off, byteRate, true);      off += 4;
  view.setUint16(off, blockAlign, true);    off += 2;
  view.setUint16(off, bitsPerSample, true); off += 2;

  // data subchunk
  writeStr('data');
  view.setUint32(off, dataSize, true);      off += 4;

  // Float32 [-1, 1] → Int16 PCM little-endian. Clip defensively; Silero's
  // output is normalized but a peaky mic can still spike past 1.0.
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Uint8Array(buf);
}
