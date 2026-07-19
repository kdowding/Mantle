// Active calls registry. One RealtimeSession per active call, keyed by
// server-generated callId. Owns lifecycle: start/get/end/closeAll. The
// WS handler in src/server/ws.ts is the only caller.

import { RealtimeSession, type RealtimeSessionOptions, type CloseReason } from "./session.js";

export class RealtimeManager {
  private readonly active: Map<string, RealtimeSession> = new Map();

  has(callId: string): boolean {
    return this.active.has(callId);
  }

  get(callId: string): RealtimeSession | undefined {
    return this.active.get(callId);
  }

  // Create a RealtimeSession, register it, and open the xAI WS. Throws
  // if the call already exists or if the WS fails to open — caller is
  // responsible for surfacing the failure to the browser.
  async start(
    callId: string,
    opts: Omit<RealtimeSessionOptions, "callId">,
  ): Promise<RealtimeSession> {
    if (this.active.has(callId)) {
      throw new Error(`call ${callId} already active`);
    }

    // Wrap onClosed so the call always leaves the registry regardless of
    // who initiated the close (server-side error, timeout, client request).
    const wrappedOnClosed = opts.onClosed;
    const session = new RealtimeSession({
      ...opts,
      callId,
      onClosed: (reason, detail) => {
        this.active.delete(callId);
        wrappedOnClosed(reason, detail);
      },
    });

    this.active.set(callId, session);
    try {
      await session.start();
    } catch (err) {
      // start() failed (upgrade never completed) — drop the registry
      // entry so a retry with the same callId isn't blocked.
      this.active.delete(callId);
      throw err;
    }
    return session;
  }

  end(callId: string, reason: CloseReason = "client"): void {
    const session = this.active.get(callId);
    if (!session) return;
    session.close(reason);
  }

  // End every active call for one agent. Used by agent purge so a deleted
  // agent's open xAI WebSockets don't keep metering. Returns how many closed.
  endForAgent(agentId: string, reason: CloseReason = "server"): number {
    let ended = 0;
    for (const [callId, session] of this.active) {
      if (session.agentId !== agentId) continue;
      try {
        session.close(reason, "agent deleted");
      } catch {
        // best effort
      }
      this.active.delete(callId);
      ended++;
    }
    return ended;
  }

  // Close every active call. Called from the mantle shutdown hook so
  // server restarts don't leak open xAI WebSockets.
  closeAll(): void {
    for (const [callId, session] of this.active) {
      try {
        session.close("server", "mantle shutting down");
      } catch {
        // best effort
      }
      this.active.delete(callId);
    }
  }

  size(): number {
    return this.active.size;
  }
}
