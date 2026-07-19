// Persist call transcripts as standard SessionMessage rows in mantle's
// session JSONL. One row per completed user or assistant turn (where
// "completed" means the xAI server emitted *_transcript.done or
// input_audio_transcription.completed). The session becomes browsable
// in the sidebar like any other — but with isCall: true on the meta so
// the UI can render it differently.

import type { SessionManager } from "../agent/session.js";

export class CallTranscript {
  private readonly session: SessionManager;
  private readonly startTime: number;

  constructor(session: SessionManager) {
    this.session = session;
    this.startTime = Date.now();
  }

  async recordUserTurn(text: string): Promise<void> {
    if (!text.trim()) return;
    await this.session.appendMessage({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      role: "user",
      content: [{ type: "text", text }],
    });
  }

  async recordAssistantTurn(text: string): Promise<void> {
    if (!text.trim()) return;
    await this.session.appendMessage({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      role: "assistant",
      content: [{ type: "text", text }],
      provider: "grok",
      model: "grok-voice-latest",
    });
  }

  durationMs(): number {
    return Date.now() - this.startTime;
  }
}
