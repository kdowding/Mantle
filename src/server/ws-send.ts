// Backpressure-gated audio sends.
//
// Audio frames are the only unbounded high-frequency WS emits in mantle —
// per-sub-chunk base64 `tts_audio` and ~25fps `call_audio`. Every other
// send is small and occasional. When the client can't drain (slow link,
// backgrounded tab, half-dead peer), Bun buffers unsent frames in process
// memory with no ceiling; a long TTS reply or an hour-long call into a
// stalled socket grows that buffer indefinitely.
//
// Policy: DROP audio frames once the socket's buffered amount crosses the
// threshold. For realtime call audio a dropped frame is strictly better
// than an ever-growing buffer (the client is live, not replaying); for TTS
// chunks it degrades to an audible gap instead of an OOM. Drops are
// counted per socket and logged periodically, never per-frame.

import type { ServerWebSocket } from "bun";

const AUDIO_BACKPRESSURE_LIMIT_BYTES = 4 * 1024 * 1024;
const DROP_LOG_EVERY = 50;

const droppedPerSocket = new WeakMap<ServerWebSocket<unknown>, number>();

/**
 * Send an audio-bearing frame unless the socket is saturated. Returns true
 * when the frame was handed to the socket, false when it was dropped (or
 * the socket threw — closed mid-send).
 */
export function sendAudioFrame(
  ws: ServerWebSocket<unknown>,
  payload: string,
  label: string,
): boolean {
  const buffered = ws.getBufferedAmount();
  if (buffered > AUDIO_BACKPRESSURE_LIMIT_BYTES) {
    const n = (droppedPerSocket.get(ws) ?? 0) + 1;
    droppedPerSocket.set(ws, n);
    if (n % DROP_LOG_EVERY === 1) {
      console.warn(
        `[MANTLE:ws] ${label}: dropping audio — client ${Math.round(buffered / 1024)}KB behind (${n} dropped on this socket)`,
      );
    }
    return false;
  }
  try {
    ws.send(payload);
    return true;
  } catch {
    return false;
  }
}
