// extractDynamicZone — the cache-prefix splice shared by every provider path
// (claude / codex / grok-build / the chat-completions family). Two contracts
// worth pinning: WHERE the block lands (latest REAL user message, tool_result
// carriers skipped, passthrough when there's no host) and the session-position
// stamp (a "session turn N" ordinal counting only real user messages — the
// anti-"every turn looks like a session opener" measure; weaker models
// re-greeted mid-chat off the unstamped brief).
import { describe, test, expect } from "bun:test";
import { extractDynamicZone } from "./provider-utils.js";
import type { ProviderMessage, SystemPromptInput } from "./types.js";

const user = (text: string): ProviderMessage => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): ProviderMessage => ({ role: "assistant", content: [{ type: "text", text }] });
const toolResult = (id: string): ProviderMessage => ({
  role: "user",
  content: [{ type: "tool_result", toolUseId: id, content: "ok" }],
});

const zones: SystemPromptInput = { stable: "STABLE", persona: "", dynamic: "DYNAMIC-BLOCK" };

const hostText = (msgs: ProviderMessage[], idx: number): string => {
  const block = msgs[idx].content[0];
  if (block.type !== "text") throw new Error("expected spliced text block first");
  return block.text;
};

describe("extractDynamicZone", () => {
  test("passes through for plain-string prompts and empty dynamic zones", () => {
    const msgs = [user("hi")];
    expect(extractDynamicZone("flat prompt", msgs).messages).toBe(msgs);
    expect(extractDynamicZone({ stable: "s", dynamic: "" }, msgs).messages).toBe(msgs);
  });

  test("passes through when no real user message can host the block", () => {
    const msgs = [toolResult("t1")];
    const res = extractDynamicZone(zones, msgs);
    expect(res.messages).toBe(msgs);
    expect(res.system).toBe(zones);
  });

  test("first message is stamped as session start", () => {
    const msgs = [user("hey what do you think we will work on today")];
    const res = extractDynamicZone(zones, msgs);
    const text = hostText(res.messages, 0);
    expect(text).toContain("[Per-turn context — session start —");
    expect(text).toContain("DYNAMIC-BLOCK");
    expect(text).toContain("[End per-turn context]");
    // System keeps stable/persona; dynamic is emptied out of it.
    expect(res.system).toEqual({ stable: "STABLE", persona: "", dynamic: "" });
  });

  test("later messages are stamped with their session-turn ordinal", () => {
    const msgs = [user("hey"), assistant("hey! ..."), user("and then?")];
    const res = extractDynamicZone(zones, msgs);
    expect(hostText(res.messages, 2)).toContain("— session turn 2 —");
    // History stays clean — only the latest real user message is wrapped.
    expect(msgs[0].content).toHaveLength(1);
    expect(res.messages[0]).toBe(msgs[0]);
  });

  test("ordinal counts only real user messages — tool_result carriers are skipped", () => {
    const msgs = [
      user("turn one"),
      assistant("calling a tool"),
      toolResult("t1"),
      assistant("done"),
      user("turn two"),
    ];
    const res = extractDynamicZone(zones, msgs);
    // The host is the last REAL user message, stamped turn 2 (not 3).
    expect(hostText(res.messages, 4)).toContain("— session turn 2 —");
  });

  test("does not mutate the input messages array", () => {
    const msgs = [user("only turn")];
    const before = msgs[0].content.length;
    extractDynamicZone(zones, msgs);
    expect(msgs[0].content.length).toBe(before);
  });
});
