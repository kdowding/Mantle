// Per-call state holder. Owns one RealtimeClient (xAI WebSocket), one
// CallTranscript (persisting to mantle's session JSONL), and the
// browser-facing event hooks for audio output + transcripts.
//
// Constructor wires up the RealtimeClient with handlers that translate
// xAI events into the browser-shaped callbacks. start() opens the WS,
// sends session.update with instructions + voice + VAD config, and
// arms the max-duration timer.

import { RealtimeClient } from "./client.js";
import type { ServerEvent, Voice } from "./protocol.js";
import { CallTranscript } from "./transcript.js";
import type { SessionManager } from "../agent/session.js";

export type CloseReason = "client" | "server" | "timeout" | "error";

export interface RealtimeSessionOptions {
  apiKey: string;
  model?: string;
  agentId: string;
  callId: string;
  sessionId: string;
  voice: Voice;
  instructions: string;
  session: SessionManager;
  maxDurationMs: number;
  // Browser-facing hooks. The WS handler in src/server/ws.ts wires
  // these to outbound WebSocket messages.
  onAudioOut: (audioBase64: string) => void;
  onUserTranscript: (text: string) => void;
  onAssistantTranscriptDelta: (text: string) => void;
  onAssistantTranscriptDone: (text: string) => void;
  onUserSpeechStart: () => void;
  onUserSpeechEnd: () => void;
  onAssistantSpeechStart: () => void;
  onAssistantSpeechEnd: () => void;
  onError: (message: string, code?: string) => void;
  onClosed: (reason: CloseReason, detail?: string) => void;
  debugLogPrefix?: string;
}

export class RealtimeSession {
  private readonly client: RealtimeClient;
  private readonly transcript: CallTranscript;
  private readonly opts: RealtimeSessionOptions;
  // Accumulates audio_transcript.delta chunks until *.done arrives, in
  // case the *.done event ever omits the full transcript (defensive).
  private assistantTextBuffer = "";
  private readonly startTime: number;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  // Which agent this call belongs to — lets RealtimeManager close an agent's
  // calls on purge without exposing the whole opts bag.
  get agentId(): string {
    return this.opts.agentId;
  }

  constructor(opts: RealtimeSessionOptions) {
    this.opts = opts;
    this.startTime = Date.now();
    this.transcript = new CallTranscript(opts.session);

    // Default to a short tag tied to the callId so multi-call sessions
    // can be untangled in the mantle log. Caller can still override via
    // opts.debugLogPrefix.
    const logPrefix = opts.debugLogPrefix
      ?? `[MANTLE:realtime ${opts.callId.slice(0, 8)}]`;

    this.client = new RealtimeClient({
      apiKey: opts.apiKey,
      model: opts.model,
      onEvent: (event) => this.handleEvent(event),
      onError: (err) => opts.onError(err.message),
      onClose: (code, reason) => {
        if (this.closed) return;
        this.closed = true;
        if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
        const detail = `code=${code} reason="${reason || "—"}"`;
        opts.onClosed("server", detail);
        this.finalizeMeta().catch(() => { /* best effort */ });
      },
      debugLogPrefix: logPrefix,
    });
  }

  // Open the xAI WS, send session.update, optionally pre-fill prior
  // turns when resuming, arm the max-duration timer. Throws if the WS
  // upgrade doesn't complete within the client's open timeout — caller
  // is responsible for surfacing that to the browser.
  async start(): Promise<void> {
    await this.client.open();

    this.client.updateSession({
      modalities: ["text", "audio"],
      instructions: this.opts.instructions,
      voice: this.opts.voice,
      input_audio_format: "audio/pcm",
      input_audio_sample_rate: 24000,
      output_audio_format: "audio/pcm",
      output_audio_sample_rate: 24000,
      // Server VAD owns turn detection. Barge-in is automatic: when
      // the user starts speaking while the assistant is talking, xAI
      // emits speech_started + cancels the in-progress response.
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        silence_duration_ms: 700,
        prefix_padding_ms: 300,
        create_response: true,
      },
      input_audio_transcription: { model: "whisper-1" },
    });

    // Resume support: if this call session already has persisted turns
    // (i.e., the user clicked "Continue this call" on an existing call
    // session), inject them into the xAI conversation via
    // conversation.item.create so the agent has context. Fresh call
    // sessions have zero messages so this is a no-op for them.
    await this.prefillFromTranscript();

    // Hard cap on call duration. Mantle's CLI side enforces this as the
    // primary cost guard since xAI's $0.05/min meter semantics aren't
    // publicly documented. 1hr default — see config.realtime in task 5.
    this.maxDurationTimer = setTimeout(() => {
      if (this.closed) return;
      console.log(
        `[realtime] call ${this.opts.callId} hit max duration (${this.opts.maxDurationMs}ms) — closing`,
      );
      this.close("timeout", `max duration ${this.opts.maxDurationMs}ms`);
    }, this.opts.maxDurationMs);
  }

  // Inject prior session turns into the xAI conversation as items so
  // the agent has full context on resume. Sent AFTER session.update
  // (so voice + instructions are in place) and BEFORE we accept
  // audio — but we deliberately do NOT call response.create here, so
  // the agent stays quiet until the user actually speaks or types.
  //
  // xAI's docs explicitly document user-role + function_call_output
  // items; assistant-role items mirror OpenAI Realtime's shape and
  // are accepted by xAI's server in practice (Grok's own app uses
  // this for call continuation). If a future xAI change rejects
  // assistant-role items, the prefill will emit `error` events but
  // the call still proceeds — agent just won't remember its own
  // prior replies.
  private async prefillFromTranscript(): Promise<void> {
    const messages = await this.opts.session.getMessages();
    if (messages.length === 0) return;

    let injected = 0;
    for (const msg of messages) {
      const text = msg.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (!text) continue;

      if (msg.role === "user") {
        this.client.createConversationItem({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        });
        injected++;
      } else if (msg.role === "assistant") {
        this.client.createConversationItem({
          type: "message",
          role: "assistant",
          content: [{ type: "text", text }],
        });
        injected++;
      }
    }

    if (injected > 0) {
      console.log(
        `[MANTLE:realtime] call ${this.opts.callId.slice(0, 8)} resumed — prefilled ${injected} prior turns`,
      );
    }
  }

  // Push base64 PCM frames from the browser to xAI. Silent no-op when
  // closed so the browser's audio worklet can keep pumping without
  // races during teardown.
  pushAudio(audioBase64: string): void {
    if (this.closed || !this.client.isOpen()) return;
    try {
      this.client.appendAudio(audioBase64);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.onError(`appendAudio failed: ${msg}`);
    }
  }

  // Inject typed user text mid-call. Triggers an explicit response.create.
  sendText(text: string): void {
    if (this.closed || !this.client.isOpen()) return;
    try {
      this.client.sendUserText(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.onError(`sendText failed: ${msg}`);
    }
  }

  // Explicit barge-in (cancel in-progress response). Usually unneeded —
  // server VAD handles automatic barge-in when the user starts speaking.
  interrupt(): void {
    if (this.closed || !this.client.isOpen()) return;
    try {
      this.client.cancelResponse();
    } catch {
      // best effort
    }
  }

  close(reason: CloseReason = "client", detail?: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    try { this.client.close(1000, detail ?? "client close"); } catch { /* ignore */ }
    this.opts.onClosed(reason, detail);
    this.finalizeMeta().catch(() => { /* best effort */ });
  }

  elapsedMs(): number {
    return Date.now() - this.startTime;
  }

  isClosed(): boolean {
    return this.closed;
  }

  // Persist final callDurationMs onto the session meta so the sidebar
  // can show call length without parsing transcript rows.
  private async finalizeMeta(): Promise<void> {
    try {
      await this.opts.session.setCallDuration(this.transcript.durationMs());
    } catch (err) {
      console.warn(
        `[realtime] failed to finalize meta for call ${this.opts.callId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private handleEvent(event: ServerEvent): void {
    switch (event.type) {
      case "error": {
        const err = (event as { error?: { message?: string; code?: string } }).error;
        this.opts.onError(err?.message ?? "unknown realtime error", err?.code);
        return;
      }

      case "input_audio_buffer.speech_started":
        this.opts.onUserSpeechStart();
        return;

      case "input_audio_buffer.speech_stopped":
        this.opts.onUserSpeechEnd();
        return;

      case "conversation.item.input_audio_transcription.completed": {
        const text = (event as { transcript?: string }).transcript ?? "";
        if (text.trim()) {
          this.opts.onUserTranscript(text);
          this.transcript.recordUserTurn(text).catch((err) => {
            console.warn(`[realtime] persist user turn: ${err instanceof Error ? err.message : err}`);
          });
        }
        return;
      }

      case "response.created":
        this.assistantTextBuffer = "";
        this.opts.onAssistantSpeechStart();
        return;

      // xAI's actual event names use `output_audio` / `output_text`
      // (matches OpenAI Realtime's newer naming, not the older
      // `audio.delta` / `text.delta` shape some docs still show).
      // Confirmed via wire trace 2026-05.
      case "response.output_audio.delta":
      case "response.audio.delta": {                        // backcompat
        const audio = (event as { delta?: string }).delta;
        if (audio) this.opts.onAudioOut(audio);
        return;
      }

      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {             // backcompat
        const delta = (event as { delta?: string }).delta ?? "";
        if (delta) {
          this.assistantTextBuffer += delta;
          this.opts.onAssistantTranscriptDelta(delta);
        }
        return;
      }

      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {              // backcompat
        const text = (event as { transcript?: string }).transcript ?? this.assistantTextBuffer;
        this.assistantTextBuffer = "";
        if (text.trim()) {
          this.opts.onAssistantTranscriptDone(text);
          this.transcript.recordAssistantTurn(text).catch((err) => {
            console.warn(`[realtime] persist assistant turn: ${err instanceof Error ? err.message : err}`);
          });
        }
        return;
      }

      // text.delta / text.done fire only when the response runs as text
      // (e.g., user typed instead of spoke). Same persistence handling.
      case "response.output_text.delta":
      case "response.text.delta": {                         // backcompat
        const delta = (event as { delta?: string }).delta ?? "";
        if (delta) {
          this.assistantTextBuffer += delta;
          this.opts.onAssistantTranscriptDelta(delta);
        }
        return;
      }

      case "response.output_text.done":
      case "response.text.done": {                          // backcompat
        const text = (event as { text?: string }).text ?? this.assistantTextBuffer;
        this.assistantTextBuffer = "";
        if (text.trim()) {
          this.opts.onAssistantTranscriptDone(text);
          this.transcript.recordAssistantTurn(text).catch((err) => {
            console.warn(`[realtime] persist assistant turn: ${err instanceof Error ? err.message : err}`);
          });
        }
        return;
      }

      case "response.done":
        this.opts.onAssistantSpeechEnd();
        return;

      // Unhandled types fall through silently. The catch-all in
      // ServerEvent keeps the bridge alive when xAI adds new event types.
      default:
        return;
    }
  }
}
