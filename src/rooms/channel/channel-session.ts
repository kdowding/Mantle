// The channel's session adapter — a SessionManager that stamps the speaking
// agent's author tag onto EVERY row the core loop appends, AT APPEND TIME.
//
// Why this exists (CHAN-1): the POV transform keys "is this my row?" on the
// author tag. The core loop knows nothing about channels, so the rows it
// appends mid-turn (the assistant message carrying tool_use blocks, the user
// message carrying tool_result blocks) used to land author-less and only the
// final assistant row got stamped post-turn. Mid-loop, the agent's own
// in-progress rows therefore looked like someone ELSE's: its tool round-trips
// vanished from its own next-iteration context (recall results never returned
// to the model) and any intermediate assistant text was permanently
// mis-prefixed with the user's name in every future speaker's projection. Stamping at
// append time makes every row attributable the instant it exists.
//
// Core stays untouched: SessionManager is subclassed, not modified, and the
// author rides as the same extra JSON property ChannelStore uses.

import { SessionManager, type SessionMessage } from "../../agent/session.js";
import type { ChannelAuthor, ChannelWhisper } from "./types.js";

export class ChannelSessionManager extends SessionManager {
  // id of the most recent ASSISTANT row this sub-turn appended — the row the
  // UI's reaction affordance targets (replaces stampLastAssistantAuthor's
  // return value). undefined when the loop never persisted a reply (abort
  // before first append, error, blank response).
  lastAssistantRowId: string | undefined;

  constructor(
    sessionId: string,
    sessionsDir: string,
    private author: ChannelAuthor,
    // Set when this sub-turn answers a private aside — every row the loop
    // appends inherits the whisper scope, so the reply stays as private as
    // the message it answers (POV drops both for everyone outside the set).
    private whisper?: ChannelWhisper,
  ) {
    // skipIndex: a channel's metadata lives in the channels REGISTRY
    // (.mantle/channels/index.json) — the per-dir index.json the base
    // class would write on every row was dead weight nothing read.
    super(sessionId, sessionsDir, { skipIndex: true });
  }

  override async appendMessage(message: SessionMessage): Promise<void> {
    const row = message as SessionMessage & { author?: ChannelAuthor; whisper?: ChannelWhisper };
    row.author = this.author;
    if (this.whisper) row.whisper = this.whisper;
    if (message.role === "assistant") this.lastAssistantRowId = message.id;
    await super.appendMessage(message);
  }
}
