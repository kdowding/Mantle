// Channel P0 invariants, ported from the throwaway
// .mantle/cache/channel-p0-verify.mjs harness into tracked bun:test and
// adapted to the post-cutover API (resolveOpeningQueue replaced
// resolveInitialSpeakers; author stamping happens at append time, not via
// the removed stampLastAssistantAuthor). The headline assertion is
// unchanged: projectForAgent NEVER emits two consecutive same-role
// messages — the provider-400 risk.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseMentions, resolveOpeningQueue, nextRoundRobinSpeaker, stripLeadingSelfPrefix } from "./mentions.js";
import { projectForAgent } from "./pov.js";
import { ChannelStore } from "./channel-store.js";
import type { ChannelMessage } from "./types.js";

// row builders
const U = (text: string): ChannelMessage => ({
  id: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  role: "user",
  content: [{ type: "text", text }],
  author: { kind: "user" },
});
const A = (agentId: string, name: string, text: string): ChannelMessage => ({
  id: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  role: "assistant",
  content: [{ type: "text", text }],
  author: { kind: "agent", agentId, name },
});
// whisper-scoped variants: user whisper to `to`, and an agent reply inside it
const UW = (text: string, to: string[]): ChannelMessage => ({ ...U(text), whisper: { to } });
const AW = (agentId: string, name: string, text: string, to: string[]): ChannelMessage => ({
  ...A(agentId, name, text),
  whisper: { to },
});
const alternates = (msgs: Array<{ role: string }>): boolean =>
  msgs.every((m, i) => i === 0 || m.role !== msgs[i - 1].role);

describe("parseMentions", () => {
  const active = ["juno", "echo", "echo-2"];
  test("single / multi / dedup / inactive / case", () => {
    expect(parseMentions("hey @juno", active)).toEqual(["juno"]);
    expect(parseMentions("@echo and @juno go", active)).toEqual(["echo", "juno"]);
    expect(parseMentions("@juno @juno @juno", active)).toEqual(["juno"]);
    expect(parseMentions("@nobody @juno", active)).toEqual(["juno"]);
    expect(parseMentions("@JUNO", active)).toEqual(["juno"]);
    expect(parseMentions("just talking", active)).toEqual([]);
  });
  test("greedy match prefers @echo-2 over @echo", () => {
    expect(parseMentions("@echo-2 then @echo", active)).toEqual(["echo-2", "echo"]);
  });
});

describe("resolveOpeningQueue", () => {
  const participants = ["juno", "echo"];
  test("live mics first (roster order), then mentions, deduped", () => {
    expect(resolveOpeningQueue("@echo hi", participants, ["juno"], undefined)).toEqual(["juno", "echo"]);
    expect(resolveOpeningQueue("@juno hi", participants, ["juno"], undefined)).toEqual(["juno"]);
  });
  test("mentions alone win without mics", () => {
    expect(resolveOpeningQueue("@echo hi", participants, [], "juno")).toEqual(["echo"]);
  });
  test("un-@'d falls back to last-active, only while still a participant", () => {
    expect(resolveOpeningQueue("hi", participants, [], "juno")).toEqual(["juno"]);
    expect(resolveOpeningQueue("hi", participants, [], "finch")).toEqual([]);
    expect(resolveOpeningQueue("hi", participants, [], undefined)).toEqual([]);
  });
});

describe("nextRoundRobinSpeaker", () => {
  test("rotates, skips yielded, refuses a solo monologue", () => {
    expect(nextRoundRobinSpeaker(["a", "b", "c"], "a", new Set())).toBe("b");
    expect(nextRoundRobinSpeaker(["a", "b", "c"], "c", new Set())).toBe("a");
    expect(nextRoundRobinSpeaker(["a", "b", "c"], "a", new Set(["b"]))).toBe("c");
    expect(nextRoundRobinSpeaker(["a"], "a", new Set())).toBeUndefined();
    expect(nextRoundRobinSpeaker([], "a", new Set())).toBeUndefined();
  });
});

describe("stripLeadingSelfPrefix", () => {
  test("strips parroted self prefix, case-insensitively, leaves clean text", () => {
    expect(stripLeadingSelfPrefix("ECHO: tabs win", "ECHO")).toBe("tabs win");
    expect(stripLeadingSelfPrefix("echo:  hey", "ECHO")).toBe("hey");
    expect(stripLeadingSelfPrefix("tabs win", "ECHO")).toBe("tabs win");
  });
});

describe("projectForAgent — strict alternation (the provider-400 guard)", () => {
  test("multi-speaker log alternates from every POV with correct mapping", () => {
    const log = [
      U("@juno @echo tabs or spaces?"),
      A("juno", "Juno", "tabs."),
      A("echo", "ECHO", "spaces."),
      U("why?"),
      A("echo", "ECHO", "readability."),
      A("juno", "Juno", "cope."),
    ];
    const junoView = projectForAgent(log, "juno");
    expect(alternates(junoView)).toBe(true);
    expect(junoView.filter((m) => m.role === "assistant")).toHaveLength(2);

    const echoView = projectForAgent(log, "echo");
    expect(alternates(echoView)).toBe(true);
    expect(
      echoView.some((m) => m.content.some((b) => b.type === "text" && b.text === "Juno: tabs.")),
    ).toBe(true);
  });

  test("consecutive non-self rows collapse into ONE user message", () => {
    const log = [U("go"), A("echo", "ECHO", "a"), A("echo", "ECHO", "b"), A("juno", "Juno", "c")];
    const view = projectForAgent(log, "juno");
    expect(alternates(view)).toBe(true);
    expect(view.filter((m) => m.role === "user")).toHaveLength(1);
  });

  test("fuzz: 200 random interleavings × 2 POVs all alternate", () => {
    const speakers = [() => U("u"), () => A("juno", "Juno", "s"), () => A("echo", "ECHO", "v")];
    for (let t = 0; t < 200; t++) {
      const n = 1 + (t % 9);
      const rows: ChannelMessage[] = [];
      for (let i = 0; i < n; i++) rows.push(speakers[(t * 7 + i * 3) % 3]());
      for (const self of ["juno", "echo"]) {
        expect(alternates(projectForAgent(rows, self))).toBe(true);
      }
    }
  });
});

describe("projectForAgent — whisper boundary (private asides)", () => {
  const text = (msgs: ReturnType<typeof projectForAgent>): string =>
    msgs.flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : ""))).join("\n");

  test("outsiders never see whisper rows; members and the asked agent do", () => {
    const log = [
      U("@juno @echo settle this in public"),
      A("juno", "Juno", "public take"),
      UW("psst @juno — between us, what do you really think?", ["juno"]),
      AW("juno", "Juno", "honestly? echo is right", ["juno"]),
      U("ok everyone, moving on"),
    ];
    // ECHO (outside the aside) must see NEITHER the whisper nor the reply.
    const echoView = text(projectForAgent(log, "echo"));
    expect(echoView).not.toContain("between us");
    expect(echoView).not.toContain("honestly?");
    expect(alternates(projectForAgent(log, "echo"))).toBe(true);
    // Juno (the whisper target) sees both, reply as its own assistant turn.
    const junoMsgs = projectForAgent(log, "juno");
    const junoView = text(junoMsgs);
    expect(junoView).toContain("between us");
    expect(junoView).toContain("honestly?");
    expect(alternates(junoMsgs)).toBe(true);
  });

  test("multi-agent aside: every member sees it, the rest of the roster doesn't", () => {
    const log = [
      U("hey all"),
      A("finch", "Finch", "hi"),
      UW("@juno @echo quick aside about finch's surprise party", ["juno", "echo"]),
      AW("juno", "Juno", "i'm in", ["juno", "echo"]),
      AW("echo", "ECHO", "me too", ["juno", "echo"]),
    ];
    expect(text(projectForAgent(log, "finch"))).not.toContain("surprise party");
    expect(text(projectForAgent(log, "juno"))).toContain("me too");
    expect(text(projectForAgent(log, "echo"))).toContain("i'm in");
    for (const self of ["juno", "echo", "finch"]) {
      expect(alternates(projectForAgent(log, self))).toBe(true);
    }
  });

  test("fuzz: whisper rows mixed in — alternation holds for every POV", () => {
    const mk = [
      () => U("u"),
      () => A("juno", "Juno", "s"),
      () => A("echo", "ECHO", "v"),
      () => UW("w", ["juno"]),
      () => AW("juno", "Juno", "wr", ["juno"]),
      () => AW("echo", "ECHO", "vr", ["echo"]),
    ];
    for (let t = 0; t < 200; t++) {
      const n = 1 + (t % 11);
      const rows: ChannelMessage[] = [];
      for (let i = 0; i < n; i++) rows.push(mk[(t * 5 + i * 7) % mk.length]());
      for (const self of ["juno", "echo", "finch"]) {
        const view = projectForAgent(rows, self);
        expect(alternates(view)).toBe(true);
        if (self === "finch") expect(text(view)).not.toContain("wr");
      }
    }
  });
});

describe("ChannelStore", () => {
  let base: string;
  let store: ChannelStore;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "mantle-chanstore-"));
    store = new ChannelStore(base);
  });

  test("create / get / list round-trip", () => {
    const ch = store.create({ title: "#the-hangout", participants: ["juno", "echo"] });
    expect(ch.id).toMatch(/^chan-[0-9a-f]{8}$/);
    expect(store.get(ch.id)?.title).toBe("#the-hangout");
    expect(store.list().some((m) => m.id === ch.id)).toBe(true);
  });

  test("transcript round-trips with author intact; agent append bumps lastActive", () => {
    const ch = store.create({ title: "t", participants: ["juno"] });
    store.appendMessage(ch.id, U("@juno hi"));
    store.appendMessage(ch.id, A("juno", "Juno", "hey"));
    const msgs = store.readMessages(ch.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].author?.kind).toBe("agent");
    expect(store.get(ch.id)?.lastActiveAgentId).toBe("juno");
  });

  test("dismiss removes from participants AND live mics", () => {
    const ch = store.create({ title: "t", participants: ["juno", "echo"] });
    store.setAutoRespond(ch.id, "juno", true);
    expect(store.get(ch.id)?.autoRespond).toContain("juno");
    store.dismiss(ch.id, "juno");
    const meta = store.get(ch.id)!;
    expect(meta.participants).not.toContain("juno");
    expect(meta.autoRespond).not.toContain("juno");
  });

  test("path-unsafe channel id throws before any fs access", () => {
    expect(() => store.channelDir("../../etc")).toThrow();
  });

  test("truncateAfterLastUser keeps the user row, drops replies, recomputes lastActive", () => {
    const ch = store.create({ title: "t", participants: ["juno", "echo"] });
    store.appendMessage(ch.id, U("first"));
    store.appendMessage(ch.id, A("juno", "Juno", "r1"));
    store.appendMessage(ch.id, U("retry me"));
    store.appendMessage(ch.id, A("echo", "ECHO", "r2"));
    const kept = store.truncateAfterLastUser(ch.id);
    expect(kept?.text).toBe("retry me");
    expect(kept?.whisper).toBeUndefined();
    const rows = store.readMessages(ch.id);
    expect(rows).toHaveLength(3);
    expect(store.get(ch.id)?.lastActiveAgentId).toBe("juno");
  });

  test("truncateAfterLastUser surfaces the kept row's whisper scope for re-routing", () => {
    const ch = store.create({ title: "t", participants: ["juno", "echo"] });
    store.appendMessage(ch.id, U("public"));
    store.appendMessage(ch.id, UW("psst", ["juno"]));
    store.appendMessage(ch.id, AW("juno", "Juno", "reply", ["juno"]));
    const kept = store.truncateAfterLastUser(ch.id);
    expect(kept?.text).toBe("psst");
    expect(kept?.whisper?.to).toEqual(["juno"]);
  });
});
