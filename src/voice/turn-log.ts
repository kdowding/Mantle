// Per-turn TTS tuning log. Captures everything we need to reason about
// audio-vs-text drift, inter-chunk gaps, cap-hit/retry behavior, and
// chunker decisions. Built progressively across a turn:
//
//   1. Server-side events (chunker emit, synth response, ws send) feed via
//      the recording API.
//   2. Server accumulates the agent's full reply text from text_delta.
//   3. Browser sends a tts_playback_report at turn end with per-chunk
//      receive/decode/play timestamps. applyClientReport() merges them.
//   4. finalize() writes a human-readable file with the full timeline +
//      summary stats.
//
// File path: <baseDir>/<agentId>/<YYYYMMDD-HHMMSS>_<synthId8>.log
//
// Disabled writes are no-ops (constructor enabled=false). Caller decides
// whether to log replays separately or alongside live turns.

import { mkdir, writeFile, readdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SynthMeta } from "./client.js";

export interface TurnLogVoiceConfig {
  temperature: number;
  cfgWeight: number;
  exaggeration: number;
}

export interface TurnLogConfig {
  enabled: boolean;
  baseDir: string;          // .mantle/voice-logs
  agentId: string;
  synthId: string;
  voice: TurnLogVoiceConfig;
  voiceRefPath: string;
  // True for replay turns (text supplied upfront, not streamed).
  isReplay: boolean;
  // For replay: the full text being replayed. For live: leave empty;
  // appendReplyText() accumulates from text_delta events.
  replayText?: string;
  // Keep at most this many .log files in the agent's dir — finalize()
  // prunes the oldest past the cap (filenames sort chronologically).
  // 0/unset = no pruning.
  keepLast?: number;
}

// Per-chunk client playback timing report. All ms values are relative to
// the client's tts_start receive — close enough to the server's turn-start
// for analytical purposes (loopback WS round-trip is typically <5ms).
export interface ClientChunkReport {
  chunkIdx: number;
  wsReceivedMs: number;
  decodeMs: number;
  playStartMs: number;
  playEndMs: number;
}

interface ChunkRecord {
  idx: number;
  text: string;
  emittedAt: number;            // ms relative to turn start
  synthRespondedAt: number;
  synthError: string | null;
  meta: SynthMeta | null;
  wsSentAt: number;
  wsReceivedAt: number | null;
  decodedAt: number | null;     // ws_received + decode_ms
  decodeMs: number | null;
  playStartedAt: number | null;
  playEndedAt: number | null;
}

export class TtsTurnLog {
  private readonly turnStart: number = Date.now();
  private readonly chunks: Map<number, ChunkRecord> = new Map();
  private agentReplyText: string;
  private finalized = false;

  constructor(private readonly config: TurnLogConfig) {
    this.agentReplyText = config.replayText ?? "";
  }

  // ── server-side recording ──────────────────────────────────────────────

  appendReplyText(t: string): void {
    if (!this.config.enabled) return;
    this.agentReplyText += t;
  }

  recordChunkEmit(idx: number, text: string): void {
    if (!this.config.enabled) return;
    const r = this._chunk(idx);
    r.text = text;
    r.emittedAt = this._t();
  }

  recordSynthResponse(idx: number, meta: SynthMeta | null): void {
    if (!this.config.enabled) return;
    const r = this._chunk(idx);
    r.synthRespondedAt = this._t();
    r.meta = meta;
  }

  recordSynthError(idx: number, err: string): void {
    if (!this.config.enabled) return;
    const r = this._chunk(idx);
    r.synthRespondedAt = this._t();
    r.synthError = err;
  }

  recordWsSend(idx: number): void {
    if (!this.config.enabled) return;
    const r = this._chunk(idx);
    r.wsSentAt = this._t();
  }

  // Sum of audio durations across all chunks. Used by the server to size
  // the log-finalize timeout — the client can't send its playback report
  // until ALL queued audio has played out, so the timer must outlast
  // synth_done by at least that much.
  totalAudioMs(): number {
    let sum = 0;
    for (const c of this.chunks.values()) {
      sum += c.meta?.audio_total_ms ?? 0;
    }
    return sum;
  }

  // ── client report merge ────────────────────────────────────────────────

  applyClientReport(reports: ClientChunkReport[]): void {
    if (!this.config.enabled) return;
    for (const rep of reports) {
      const r = this.chunks.get(rep.chunkIdx);
      if (!r) continue;
      r.wsReceivedAt = rep.wsReceivedMs;
      r.decodeMs = rep.decodeMs;
      r.decodedAt = rep.wsReceivedMs + rep.decodeMs;
      r.playStartedAt = rep.playStartMs;
      r.playEndedAt = rep.playEndMs;
    }
  }

  // ── finalize ───────────────────────────────────────────────────────────

  async finalize(): Promise<string | null> {
    if (!this.config.enabled || this.finalized) return null;
    this.finalized = true;

    const file = this._buildPath();
    const body = this._formatLog();

    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, body, "utf-8");
      await this._pruneOld(dirname(file));
      return file;
    } catch (err) {
      console.warn(
        `[voice:turn-log] failed to write ${file}: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  // Keep the agent's log dir bounded: one file lands per voice turn, and
  // nothing else ever deleted them. Timestamp-prefixed names sort
  // chronologically, so "oldest" = lexicographic head. Best-effort.
  private async _pruneOld(dir: string): Promise<void> {
    const keep = this.config.keepLast ?? 0;
    if (keep <= 0) return;
    try {
      const logs = (await readdir(dir)).filter((f) => f.endsWith(".log")).sort();
      const excess = logs.length - keep;
      for (let i = 0; i < excess; i++) {
        await unlink(resolve(dir, logs[i]!)).catch(() => {});
      }
    } catch {
      // dir vanished or unreadable — nothing to prune
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private _t(): number {
    return Date.now() - this.turnStart;
  }

  private _chunk(idx: number): ChunkRecord {
    let r = this.chunks.get(idx);
    if (!r) {
      r = {
        idx,
        text: "",
        emittedAt: -1,
        synthRespondedAt: -1,
        synthError: null,
        meta: null,
        wsSentAt: -1,
        wsReceivedAt: null,
        decodedAt: null,
        decodeMs: null,
        playStartedAt: null,
        playEndedAt: null,
      };
      this.chunks.set(idx, r);
    }
    return r;
  }

  private _buildPath(): string {
    const d = new Date(this.turnStart);
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp =
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const synthShort = this.config.synthId.slice(0, 8);
    const replayTag = this.config.isReplay ? "_replay" : "";
    return resolve(this.config.baseDir, this.config.agentId, `${stamp}${replayTag}_${synthShort}.log`);
  }

  // ── formatter ──────────────────────────────────────────────────────────

  private _formatLog(): string {
    const ordered = [...this.chunks.values()].sort((a, b) => a.idx - b.idx);
    const startIso = new Date(this.turnStart).toISOString();
    const lines: string[] = [];

    lines.push("=== MANTLE TTS Turn Log ===");
    lines.push(`Started:    ${startIso}`);
    lines.push(`Mode:       ${this.config.isReplay ? "replay" : "live"}`);
    lines.push(`Agent:      ${this.config.agentId}`);
    lines.push(`SynthId:    ${this.config.synthId}`);
    lines.push(`Voice ref:  ${this.config.voiceRefPath}`);
    lines.push("");

    lines.push("--- Voice config ---");
    lines.push(`Temperature:  ${this.config.voice.temperature}`);
    lines.push(`CFG weight:   ${this.config.voice.cfgWeight}`);
    lines.push(`Exaggeration: ${this.config.voice.exaggeration}`);
    lines.push("");

    lines.push("--- Agent reply (full text) ---");
    lines.push(this.agentReplyText.trimEnd() || "(no reply text captured)");
    lines.push("");

    // Counts for header. cap-hit/retry/split metrics are gone with the
    // chatterbox-streaming migration — the streaming model has no retry
    // surface and no python-side splitter, so the only failure mode is
    // synth error.
    const errCount = ordered.filter((c) => c.synthError).length;

    lines.push(`--- Chunks: ${ordered.length} (${errCount} error) ---`);
    lines.push("");

    let prevPlayEndedAt: number | null = null;
    const interChunkGaps: { idx: number; gapMs: number; lastChar: string }[] = [];

    for (const c of ordered) {
      const audioMs = c.meta?.audio_total_ms ?? 0;
      const synthMs = c.meta?.synth_total_ms ?? 0;
      const ttfbMs = c.meta?.ttfb_ms ?? 0;
      const subChunks = c.meta?.num_sub_chunks ?? 0;
      const flags: string[] = [];
      if (c.synthError) flags.push("ERROR");
      const flagStr = flags.length ? ` [${flags.join(",")}]` : "";

      lines.push(
        `[${c.idx}] ${c.text.length}c · synth=${synthMs}ms · audio=${audioMs}ms` +
        ` · ttfb=${ttfbMs}ms · ${subChunks} sub-chunk${subChunks === 1 ? "" : "s"}${flagStr}`,
      );
      lines.push(`    Text: ${JSON.stringify(c.text)}`);

      // Server timeline
      if (c.emittedAt >= 0) lines.push(`    [T+${_pad(c.emittedAt)}] chunker emit`);
      if (c.synthRespondedAt >= 0) {
        const synthDur = c.synthRespondedAt - c.emittedAt;
        lines.push(`    [T+${_pad(c.synthRespondedAt)}] synth done   (${synthDur}ms)`);
      }
      if (c.synthError) {
        lines.push(`    [T+${_pad(c.synthRespondedAt)}] synth ERROR: ${c.synthError}`);
      }
      if (c.wsSentAt >= 0) lines.push(`    [T+${_pad(c.wsSentAt)}] ws send`);

      // Client timeline (if reported)
      if (c.wsReceivedAt !== null) {
        const wsLatency = c.wsReceivedAt - c.wsSentAt;
        lines.push(`    [T+${_pad(c.wsReceivedAt)}] ws received  (latency: ${wsLatency}ms)`);
      }
      if (c.decodedAt !== null && c.decodeMs !== null) {
        lines.push(`    [T+${_pad(c.decodedAt)}] decoded      (${c.decodeMs}ms)`);
      }
      if (c.playStartedAt !== null) {
        const gap = prevPlayEndedAt === null ? null : c.playStartedAt - prevPlayEndedAt;
        const gapStr = gap === null ? "" : `   (gap from prior play end: ${gap}ms)`;
        lines.push(`    [T+${_pad(c.playStartedAt)}] PLAY START${gapStr}`);
        if (gap !== null) {
          // Look at the last non-quote char of the prior chunk's text to
          // categorize the gap (sentence-end vs mid-sentence).
          const prev = _findChunkByPlayEnd(ordered, prevPlayEndedAt);
          const lastChar = prev ? _lastSignificantChar(prev.text) : "?";
          interChunkGaps.push({ idx: c.idx, gapMs: gap, lastChar });
        }
      }
      if (c.playEndedAt !== null) {
        const playDur = c.playStartedAt !== null ? c.playEndedAt - c.playStartedAt : null;
        const audDurStr = playDur !== null ? `   (audio: ${playDur}ms)` : "";
        lines.push(`    [T+${_pad(c.playEndedAt)}] PLAY END${audDurStr}`);
        prevPlayEndedAt = c.playEndedAt;
      }

      // No per-piece detail in the streaming era — sub-chunk timing
      // metadata isn't surfaced through the per-call API. (Phase 2 will
      // add it back when sub-chunks become first-class WS events.)
      lines.push("");
    }

    // Summary
    lines.push("=== Summary ===");
    const totalSynthMs = ordered.reduce((s, c) => s + (c.meta?.synth_total_ms ?? 0), 0);
    const totalAudioMs = ordered.reduce((s, c) => s + (c.meta?.audio_total_ms ?? 0), 0);
    const lastEvent = ordered.reduce((m, c) => Math.max(
      m, c.emittedAt, c.synthRespondedAt, c.wsSentAt,
      c.wsReceivedAt ?? -1, c.playEndedAt ?? -1,
    ), 0);
    lines.push(`Total chunks:        ${ordered.length}`);
    lines.push(`  errors:            ${errCount}`);
    lines.push(`Reply length:        ${this.agentReplyText.length} chars`);
    lines.push(`Total audio:         ${totalAudioMs}ms (${(totalAudioMs / 1000).toFixed(2)}s)`);
    lines.push(`Total synth wall:    ${totalSynthMs}ms (${(totalSynthMs / 1000).toFixed(2)}s)`);
    lines.push(`Total turn duration: ${lastEvent}ms (${(lastEvent / 1000).toFixed(2)}s)`);
    lines.push("");

    // Inter-chunk gap analysis — the tuning gold mine
    if (interChunkGaps.length) {
      const gaps = interChunkGaps.map((g) => g.gapMs);
      const min = Math.min(...gaps);
      const max = Math.max(...gaps);
      const avg = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length);
      const over300 = gaps.filter((g) => g > 300).length;
      lines.push("Inter-chunk play gaps (smaller = tighter playback):");
      lines.push(`  count:   ${gaps.length}`);
      lines.push(`  min:     ${min}ms`);
      lines.push(`  max:     ${max}ms`);
      lines.push(`  avg:     ${avg}ms`);
      lines.push(`  >300ms:  ${over300} occurrence${over300 === 1 ? "" : "s"}`);

      // Group by trailing punctuation of prior chunk
      const byChar = new Map<string, number[]>();
      for (const g of interChunkGaps) {
        const cat = _categorizeChar(g.lastChar);
        const arr = byChar.get(cat) ?? [];
        arr.push(g.gapMs);
        byChar.set(cat, arr);
      }
      const order = ["sentence-end", "mid-sentence", "other"];
      for (const cat of order) {
        const arr = byChar.get(cat);
        if (!arr || !arr.length) continue;
        const a = Math.round(arr.reduce((s, x) => s + x, 0) / arr.length);
        lines.push(`  ${cat.padEnd(13)}: avg ${a}ms (n=${arr.length})`);
      }
      lines.push("");

      // Per-gap detail (table)
      lines.push("Per-gap detail:");
      for (const g of interChunkGaps) {
        const cat = _categorizeChar(g.lastChar);
        lines.push(`  before chunk ${g.idx}: ${g.gapMs}ms (prior ended on '${g.lastChar}', ${cat})`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}

// ── module helpers ─────────────────────────────────────────────────────────

function _pad(n: number): string {
  return String(n).padStart(6, " ");
}

function _findChunkByPlayEnd(chunks: ChunkRecord[], playEnd: number | null): ChunkRecord | null {
  if (playEnd === null) return null;
  return chunks.find((c) => c.playEndedAt === playEnd) ?? null;
}

function _lastSignificantChar(text: string): string {
  // Walk back from the end past closing punctuation/whitespace, return the
  // last "meaningful" char so we can categorize the boundary.
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === " " || ch === "\n" || ch === "\t") continue;
    if (ch === '"' || ch === "'" || ch === ")" || ch === "”" || ch === "’") continue;
    return ch;
  }
  return "";
}

function _categorizeChar(ch: string): "sentence-end" | "mid-sentence" | "other" {
  if (ch === "." || ch === "!" || ch === "?") return "sentence-end";
  if (ch === "," || ch === ";" || ch === ":") return "mid-sentence";
  return "other";
}
