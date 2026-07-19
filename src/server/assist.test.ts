// The deck-assist conversation is a real hidden session (isAssist) loaded via
// GET …/assist/session and cleared via DELETE. These cover the two pieces that
// the persistence depends on: createSessionMeta stamps isAssist (so the sidebar
// filter catches it), and the dock projection keeps the chat turns while
// dropping the tool_use / tool_result rows a propose_edit turn produces — so a
// reload shows the conversation, not orphan empty bubbles.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SessionManager, type SessionMessage } from "../agent/session.js";
import { projectAssistConversation } from "./assist.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mantle-assist-"));
});

const msg = (role: SessionMessage["role"], content: SessionMessage["content"]): SessionMessage => ({
  id: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  role,
  content,
});
const userText = (text: string) => msg("user", [{ type: "text", text }]);
const asstText = (text: string) => msg("assistant", [{ type: "text", text }]);

describe("projectAssistConversation", () => {
  test("keeps user/assistant text turns, drops tool_use / tool_result rows", () => {
    const transcript: SessionMessage[] = [
      userText("set up a morning briefing"),
      asstText("Here's a draft."),
      // A propose_edit turn: assistant emits only a tool_use, then a tool_result
      // lands as a user row — neither has display text.
      msg("assistant", [{ type: "tool_use", id: "t1", name: "propose_edit", input: {} }]),
      msg("user", [{ type: "tool_result", toolUseId: "t1", content: "staged" }]),
      asstText("Staged it for review."),
      // System rows (compaction summaries) never reach the dock.
      msg("system", [{ type: "text", text: "[Conversation Summary] …" }]),
    ];
    expect(projectAssistConversation(transcript)).toEqual([
      { role: "user", text: "set up a morning briefing" },
      { role: "assistant", text: "Here's a draft." },
      { role: "assistant", text: "Staged it for review." },
    ]);
  });

  test("empty transcript projects to nothing", () => {
    expect(projectAssistConversation([])).toEqual([]);
  });

  test("user turns carry their assistContext chip; assistant turns don't", () => {
    const transcript: SessionMessage[] = [
      { ...userText("tighten this"), assistContext: { kind: "skill", label: "agent/commit-style/SKILL.md" } },
      asstText("Done — trimmed the description."),
    ];
    const out = projectAssistConversation(transcript);
    expect(out[0]).toEqual({ role: "user", text: "tighten this", context: { kind: "skill", label: "agent/commit-style/SKILL.md" } });
    expect(out[1]).toEqual({ role: "assistant", text: "Done — trimmed the description." });
  });
});

describe("assist session round-trip", () => {
  test("createSessionMeta stamps isAssist so the sidebar filter catches it", () => {
    SessionManager.createSessionMeta("assist", dir, { isAssist: true, title: "Systems assist" });
    const meta = SessionManager.loadIndex(dir).sessions.find((s) => s.id === "assist");
    expect(meta?.isAssist).toBe(true);
  });

  test("append → project round-trips the chat turns; delete wipes it", async () => {
    const s = new SessionManager("assist", dir);
    await s.appendMessage(userText("why isn't this firing?"));
    await s.appendMessage(asstText("The watch path never changes."));
    await s.appendMessage(msg("assistant", [{ type: "tool_use", id: "t1", name: "propose_edit", input: {} }]));
    await s.appendMessage(msg("user", [{ type: "tool_result", toolUseId: "t1", content: "staged" }]));

    expect(projectAssistConversation(await s.getMessages())).toEqual([
      { role: "user", text: "why isn't this firing?" },
      { role: "assistant", text: "The watch path never changes." },
    ]);

    expect(SessionManager.deleteSession("assist", dir)).toBe(true);
    expect(await new SessionManager("assist", dir).getMessages()).toEqual([]);
  });
});
