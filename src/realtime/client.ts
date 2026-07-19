// WebSocket client for xAI's Grok Voice Agent API.
//
// Thin typed wrapper around the realtime endpoint:
//   wss://api.x.ai/v1/realtime?model=<model>
//
// Auth: Bearer XAI_API_KEY header. Server-side only — the standard
// browser WebSocket constructor doesn't accept custom headers, so this
// client lives behind mantle's proxy (browser → mantle WS → xAI WS).
//
// Lifecycle: callers wire onEvent (firehose of every parsed server
// event), then call open() which resolves when the WebSocket UPGRADE
// completes (deliberately NOT on `session.created` — xAI leads with
// `conversation.created` + heartbeat pings and may never send an
// unprompted session.created). After that, use the typed send helpers
// (updateSession, appendAudio, sendUserText, cancelResponse, close). The
// higher-level call bridge in src/realtime/session.ts owns lifecycle +
// state — this class only handles the wire protocol.

import {
  REALTIME_ENDPOINT,
  DEFAULT_MODEL,
  type ClientEvent,
  type ServerEvent,
  type SessionConfig,
  type ConversationItem,
} from "./protocol.js";

export interface RealtimeClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  onEvent: (event: ServerEvent) => void;
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (error: Error) => void;
  // When set, logs every inbound + outbound event type to stdout with
  // the given prefix. Useful while iterating; off by default.
  debugLogPrefix?: string;
  // How long to wait for the WebSocket upgrade to complete before
  // failing the call. Prevents the browser from sitting on "Connecting…"
  // indefinitely when the upstream accepts the TCP connection but never
  // finishes the handshake (e.g. auth header dropped, wrong base URL).
  openTimeoutMs?: number;
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private readonly opts: RealtimeClientOptions;
  private readonly url: string;
  // Activity counters for the on-close summary. Per-frame audio events
  // (input_audio_buffer.append outbound, response.*audio*.delta inbound)
  // are logged silently — printing each one drowns out turn-boundary
  // events. The counters surface on close as a single one-liner so we
  // still know how much audio flowed.
  private sentFrames = 0;
  private sentBytesB64 = 0;
  private recvAudioDeltas = 0;
  private recvAudioBytesB64 = 0;
  private recvTranscriptDeltas = 0;

  constructor(opts: RealtimeClientOptions) {
    this.opts = opts;
    const base = opts.baseUrl ?? REALTIME_ENDPOINT;
    const model = opts.model ?? DEFAULT_MODEL;
    this.url = `${base}?model=${encodeURIComponent(model)}`;
  }

  // Open the WebSocket; resolves when the UPGRADE completes (see the
  // module header — waiting on session.created would hang against xAI's
  // actual protocol). Rejects if the socket errors/closes first, or the
  // upgrade doesn't complete within openTimeoutMs.
  async open(): Promise<void> {
    if (this.ws) throw new Error("RealtimeClient already opened");
    const log = this.opts.debugLogPrefix;
    if (log) console.log(`${log} opening ${this.url}`);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      let ws: WebSocket;

      const openTimeoutMs = this.opts.openTimeoutMs ?? 15000;
      const finishSettle = (ok: boolean, errOrUndef?: Error) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        if (ok) resolve();
        else reject(errOrUndef ?? new Error("unknown error opening xAI Realtime WS"));
      };

      try {
        // Bun's WebSocket client extends the standard API with a
        // `headers` option for cases like this where bearer auth must
        // ride on the upgrade request. Cast through `unknown` because
        // the TS lib.dom shape doesn't include `headers`.
        ws = new WebSocket(this.url, {
          headers: {
            Authorization: `Bearer ${this.opts.apiKey}`,
          },
        } as unknown as undefined);
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        if (log) console.warn(`${log} WebSocket constructor threw: ${wrapped.message}`);
        finishSettle(false, wrapped);
        return;
      }

      this.ws = ws;

      // Reject if the upgrade never completes after TCP connect. 15s is
      // a safe cap against auth header drops / wrong base URL / silent
      // rejections.
      timeoutHandle = setTimeout(() => {
        if (settled) return;
        if (log) console.warn(`${log} timed out after ${openTimeoutMs}ms — WebSocket upgrade never completed`);
        try { ws.close(1000, "open timeout"); } catch { /* ignore */ }
        finishSettle(false, new Error(
          `xAI Realtime upgrade did not complete within ${openTimeoutMs}ms — check API key, model id, or upstream connectivity`,
        ));
      }, openTimeoutMs);

      ws.onopen = () => {
        if (log) console.log(`${log} TCP connected — settling open()`);
        this.opts.onOpen?.();
        // Resolve as soon as the upgrade succeeds. xAI's protocol leads
        // with `conversation.created` and heartbeat `ping` events; an
        // unprompted `session.created` may never arrive. session.update
        // can be sent immediately on an open WS — if auth/model were
        // wrong, an `error` event + close will follow shortly and we'll
        // surface it via onClose → onClosed → call_closed.
        finishSettle(true);
      };

      ws.onmessage = (msg: MessageEvent) => {
        let parsed: ServerEvent;
        try {
          const text = typeof msg.data === "string"
            ? msg.data
            : new TextDecoder().decode(msg.data as ArrayBuffer);
          parsed = JSON.parse(text);
        } catch (err) {
          this.opts.onError?.(new Error(
            `Failed to parse server event: ${err instanceof Error ? err.message : String(err)}`,
          ));
          return;
        }

        // Application-level heartbeat. xAI sends {"type":"ping"} on a
        // ~5-15s cadence; reply with pong so they don't close on idle.
        // Silent — protocol noise once we've confirmed pong works.
        if (parsed.type === "ping") {
          try {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ type: "pong" }));
            }
          } catch { /* ignore — WS likely closing */ }
          return;
        }

        // Per-frame events get counted silently instead of logged. The
        // close-time summary in onclose reports totals. Everything else
        // (turn boundaries, errors, transcripts.done, etc.) still logs
        // since those are turn-level signals, not firehose.
        const isAudioFrame = parsed.type === "response.output_audio.delta"
          || parsed.type === "response.audio.delta";
        const isTranscriptFrame = parsed.type === "response.output_audio_transcript.delta"
          || parsed.type === "response.audio_transcript.delta"
          || parsed.type === "response.output_text.delta"
          || parsed.type === "response.text.delta";

        if (isAudioFrame) {
          this.recvAudioDeltas++;
          this.recvAudioBytesB64 += typeof (parsed as { delta?: string }).delta === "string"
            ? (parsed as { delta: string }).delta.length
            : 0;
        } else if (isTranscriptFrame) {
          this.recvTranscriptDeltas++;
        } else if (log) {
          console.log(`${log} ← ${parsed.type}`);
          if (parsed.type === "error") {
            const e = (parsed as { error?: unknown }).error;
            console.warn(`${log}   error payload: ${JSON.stringify(e)}`);
          }
        }

        // Belt-and-suspenders: if onopen never fired before the first
        // event landed (rare runtime ordering quirk), settle here too.
        // finishSettle is idempotent.
        if (!settled) finishSettle(true);

        try {
          this.opts.onEvent(parsed);
        } catch (err) {
          this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      };

      ws.onerror = (_ev) => {
        // WebSocket's `onerror` carries no useful message — the close
        // event that follows usually does. We surface a generic error
        // so callers see something, and onclose carries the code/reason.
        const err = new Error("xAI Realtime WebSocket error");
        if (log) console.warn(`${log} onerror fired`);
        if (!settled) finishSettle(false, err);
        this.opts.onError?.(err);
      };

      ws.onclose = (ev: CloseEvent) => {
        if (log) {
          const sentKB = (this.sentBytesB64 / 1024).toFixed(1);
          const recvKB = (this.recvAudioBytesB64 / 1024).toFixed(1);
          console.log(
            `${log} onclose code=${ev.code} reason="${ev.reason || "—"}" ` +
            `wasClean=${ev.wasClean} (sent ${this.sentFrames}f/${sentKB}KB, ` +
            `recv ${this.recvAudioDeltas}audio/${recvKB}KB + ${this.recvTranscriptDeltas}text deltas)`,
          );
        }
        if (!settled) {
          finishSettle(false, new Error(
            `xAI Realtime closed before the upgrade completed (code=${ev.code} reason="${ev.reason || "—"}")`,
          ));
        }
        this.opts.onClose?.(ev.code, ev.reason);
        this.ws = null;
      };
    });
  }

  // Internal generic send. Throws if not open — callers should check
  // isOpen() if they want to gate on connection state.
  private send(event: ClientEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`RealtimeClient not open (state=${this.ws?.readyState ?? "null"})`);
    }
    // Per-frame audio.append gets counted silently — printing 25 lines/sec
    // makes the rest of the log unreadable. Everything else (turn-level
    // session.update, response.create, etc.) still logs.
    if (event.type === "input_audio_buffer.append") {
      this.sentFrames++;
      this.sentBytesB64 += event.audio?.length ?? 0;
    } else if (this.opts.debugLogPrefix) {
      console.log(`${this.opts.debugLogPrefix} → ${event.type}`);
    }
    this.ws.send(JSON.stringify(event));
  }

  // ── Typed send helpers ───────────────────────────────────────────────

  updateSession(session: SessionConfig): void {
    this.send({ type: "session.update", session });
  }

  // Push base64-encoded audio frames. Format/sample-rate must match
  // what was set via updateSession's input_audio_format / *_sample_rate.
  appendAudio(audioBase64: string): void {
    this.send({ type: "input_audio_buffer.append", audio: audioBase64 });
  }

  // Manual turn commit. With server VAD this is automatic — only call
  // when turn_detection is set to null on the session.
  commitAudio(): void {
    this.send({ type: "input_audio_buffer.commit" });
  }

  clearAudio(): void {
    this.send({ type: "input_audio_buffer.clear" });
  }

  createConversationItem(item: ConversationItem, previousItemId?: string | null): void {
    this.send({
      type: "conversation.item.create",
      previous_item_id: previousItemId ?? null,
      item,
    });
  }

  // Inject text from the user mid-call (e.g., typing while on a voice
  // call). Triggers an explicit response.create afterward since
  // turn_detection only auto-creates responses after audio turns.
  sendUserText(text: string): void {
    this.createConversationItem({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    });
    this.send({ type: "response.create" });
  }

  // Cancel an in-progress assistant response. Used for explicit
  // barge-in (server VAD handles this automatically, but the client
  // can force-cancel if needed).
  cancelResponse(): void {
    this.send({ type: "response.cancel" });
  }

  // Explicit response trigger. With server VAD enabled, the server
  // creates responses automatically after each user turn — only call
  // this when running with turn_detection: null.
  createResponse(overrides?: Partial<SessionConfig>): void {
    this.send({ type: "response.create", response: overrides });
  }

  // Clean close. The onclose callback fires as usual; this.ws is
  // cleared on close so isOpen() goes false immediately.
  close(code: number = 1000, reason: string = "normal close"): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      try {
        this.ws.close(code, reason);
      } catch {
        // ignore — already closed/closing
      }
    }
    this.ws = null;
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
