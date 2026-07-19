// Mid-stream sentence chunker. Watches the LLM's text_delta stream and
// flushes complete sentences to TTS as soon as they land, instead of
// waiting for message_end. Cuts time-to-first-audio dramatically — the
// user starts hearing the reply ~1 second into generation rather than
// after the full response finishes.
//
// Boundary policy:
//   - Flush when buffer ends in sentence-final punctuation (.!?)
//     followed by whitespace OR newline OR end-of-stream, AND the
//     buffer is at least minChars long.
//   - Force-flush at maxChars by splitting on the most recent
//     whitespace (never mid-word).
//   - flush() at message_end emits any tail under minChars unchanged.
//
// Sub-sentence punctuation (commas, semicolons) is intentionally NOT a
// boundary — Chatterbox-Turbo's prosody planning needs full sentences
// to lay out cadence properly. Splitting on commas produces stilted,
// list-y delivery.

export interface StreamChunkerOptions {
  minChars?: number;
  maxChars?: number;
  // Lower minChars threshold for the FIRST chunk only. The opening
  // sentence dominates time-to-first-audio, so we ship it slightly sooner
  // than later chunks. Sized to give chunk 1's playback enough headroom
  // to mask chunk 2's synth time — going too low (e.g. 30 chars → ~2.5s
  // playback) leaves audible gaps when chunk 2 needs ~1-1.5s to synthesize.
  // 50 chars produces ~4s of audio, comfortably longer than worst-case
  // chunk-2 synth at default cfmTimesteps. Subsequent chunks fall back to
  // minChars for prosody (Chatterbox lays out cadence better with longer
  // chunks).
  firstChunkMinChars?: number;
  onChunk: (text: string, idx: number) => void | Promise<void>;
}

const DEFAULT_MIN_CHARS = 60;
const DEFAULT_MAX_CHARS = 200;
const DEFAULT_FIRST_CHUNK_MIN_CHARS = 50;

// Closing punctuation that can follow sentence-final .!? before the
// actual whitespace boundary. Includes ASCII " ' ) and the smart-quote
// closers ” (right double) and ’ (right single).
const _CLOSING_CHARS = new Set(['"', "'", ')', '”', '’']);

export class StreamChunker {
  private buf = "";
  private idx = 0;
  private readonly minChars: number;
  private readonly maxChars: number;
  private readonly firstChunkMinChars: number;
  private readonly onChunk: StreamChunkerOptions["onChunk"];

  constructor(opts: StreamChunkerOptions) {
    this.minChars = opts.minChars ?? DEFAULT_MIN_CHARS;
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    this.firstChunkMinChars = opts.firstChunkMinChars ?? DEFAULT_FIRST_CHUNK_MIN_CHARS;
    this.onChunk = opts.onChunk;
  }

  // Accept a streaming text delta. May trigger 0..N chunk emissions
  // depending on how much sentence-completion landed in this delta.
  feed(text: string): void {
    if (!text) return;
    this.buf += text;
    this._tryFlushBoundaries();
    this._enforceMaxChars();
  }

  // Drain remaining buffered text. Called once after the agent loop
  // emits message_end so any tail (a final fragment under minChars,
  // or a sentence without trailing whitespace) makes it to the UI.
  flush(): void {
    // Trim trailing whitespace only — leading whitespace (paragraph
    // breaks left in the buf after a previous mid-stream cut) gets
    // preserved so the UI can render `\n\n` as a paragraph in markdown.
    const tail = this.buf.replace(/\s+$/, "");
    this.buf = "";
    if (!tail.trim()) return;
    this._emit(tail);
  }

  // Reset state without emitting. Used on stop/abort so the next turn
  // starts fresh.
  reset(): void {
    this.buf = "";
    this.idx = 0;
  }

  private _tryFlushBoundaries(): void {
    // Carve off the smallest left-prefix that ends at a sentence
    // boundary AND meets minChars. Repeat until no such prefix exists,
    // then leave the rest in the buffer for the next feed() call.
    //
    // Leading whitespace is preserved on the chunk so paragraph breaks
    // (`\n\n` between sentences) survive into the UI display path. The
    // synth path strips it before sending to chatterbox; the python
    // normalizer then turns `\n\n` into a sentence-pause.
    while (true) {
      const cut = this._findFlushPoint();
      if (cut === -1) return;
      const chunk = this.buf.slice(0, cut + 1).replace(/\s+$/, "");
      this.buf = this.buf.slice(cut + 1);
      if (chunk.trim()) this._emit(chunk);
    }
  }

  // Walk forward through the buffer, accumulating boundaries. Return the
  // index of the first boundary where the prefix is at least minChars
  // long. Multiple short sentences naturally merge: "Yes. OK. Got it."
  // (5 + 4 + 8 = 17 chars) won't flush at minChars=30, but adding "This
  // is the next sentence." brings us past the threshold and we flush
  // the whole accumulated run as one chunk. Returns -1 if no valid
  // flush point exists yet.
  private _findFlushPoint(): number {
    // First chunk uses a lower minChars threshold to cut time-to-first-
    // audio. Subsequent chunks use the full minChars so Chatterbox has
    // enough material per chunk to plan prosody well.
    const minChars = this.idx === 0 ? this.firstChunkMinChars : this.minChars;
    for (let i = 0; i < this.buf.length; i++) {
      const ch = this.buf[i];
      if (ch !== "." && ch !== "!" && ch !== "?") continue;
      // Sentence-final punctuation may be followed by closing quotes or
      // parens before the actual whitespace boundary, e.g.
      //   `He said "hi." Then left.`  → `."` is the boundary cluster
      //   `(That worked.) Next part.` → `.)` is the boundary cluster
      // Walk past any closing chars so we treat the cluster as a unit.
      let j = i + 1;
      while (j < this.buf.length && _CLOSING_CHARS.has(this.buf[j])) j++;
      const next = j < this.buf.length ? this.buf[j] : undefined;
      // Sentence boundary requires trailing whitespace, newline, or
      // end-of-buffer. Numeric ("3.14") and abbreviation ("e.g.")
      // false-positives die here because the next char is a non-space.
      const isBoundary = next === undefined || next === " " || next === "\n" || next === "\t";
      if (!isBoundary) continue;
      // Use the last char of the cluster as the cut point so the closing
      // quote/paren stays with this chunk's audio.
      const cut = j - 1;
      // Boundary found — flush only if prefix already meets the minChars
      // threshold for this chunk's position (first vs subsequent).
      const prefixLen = this.buf.slice(0, cut + 1).trim().length;
      if (prefixLen >= minChars) return cut;
    }
    return -1;
  }

  private _enforceMaxChars(): void {
    if (this.buf.length <= this.maxChars) return;
    // Split at the most recent whitespace before maxChars to avoid
    // cutting mid-word. If no whitespace exists in that window (rare
    // edge case — a giant URL or token), give up and split at maxChars.
    let cut = this.buf.lastIndexOf(" ", this.maxChars);
    if (cut < this.minChars) cut = this.maxChars;
    const left = this.buf.slice(0, cut).trim();
    if (left) this._emit(left);
    this.buf = this.buf.slice(cut).trimStart();
  }

  private _emit(text: string): void {
    const idx = this.idx++;
    // Fire-and-forget — onChunk is async and may take 1-3s for synth,
    // but we MUST keep accepting deltas during that time. Caller's
    // onChunk is responsible for ordering chunk emissions to the UI.
    Promise.resolve(this.onChunk(text, idx)).catch((err) => {
      console.error(`[voice:chunker] onChunk failed for chunk ${idx}: ${err instanceof Error ? err.message : err}`);
    });
  }
}
