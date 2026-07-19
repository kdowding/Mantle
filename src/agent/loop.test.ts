// Loop stop-cause + regression tests, ported from the throwaway
// .mantle/cache/tier0-verify.mjs harness into tracked bun:test. A
// scriptable FakeProvider drives the REAL runAgentLoop to each outcome;
// new regressions from the 2026-06 pass ride along (end_turn-with-tools
// strip, provider errorKind passthrough, abort classification).

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgentLoop, type AgentStreamEvent } from "./loop.js";
import { SessionManager } from "./session.js";
import type { ProviderEvent, ProviderStreamParams } from "./providers/types.js";
import { repairToolArgs } from "../tools/core/tool-arg-repair.js";
import { rethrowIfAborted, classifyProviderError } from "./providers/provider-utils.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mantle-loop-"));
});

const ME = (stopReason: "tool_use" | "end_turn" | "max_tokens" = "tool_use"): ProviderEvent =>
  ({ type: "message_end", stopReason, usage: { inputTokens: 1, outputTokens: 1 } });

function toolTurn(id: string, name: string, argsJson: string): ProviderEvent[] {
  return [
    { type: "tool_call_start", id, name },
    { type: "tool_call_delta", id, args: argsJson },
    { type: "tool_call_end", id },
    ME(),
  ];
}
const textTurn = (text: string): ProviderEvent[] => [
  { type: "text_delta", text },
  ME("end_turn"),
];

// Scriptable provider. Tool-bearing calls walk `turns`; a tools:[] call
// (the graceful-landing pass) always yields `landingText`.
class FakeProvider {
  name = "fake";
  i = 0;
  landingCalled = false;
  constructor(
    private turns: ProviderEvent[][],
    private landingText = "LANDED: summary",
  ) {}
  async *stream(params: ProviderStreamParams): AsyncIterable<ProviderEvent> {
    if (params.tools.length === 0) {
      this.landingCalled = true;
      yield { type: "text_delta", text: this.landingText };
      yield ME("end_turn");
      return;
    }
    const turn = this.turns[Math.min(this.i, this.turns.length - 1)];
    this.i++;
    yield* turn;
  }
}

async function freshSession(tag: string): Promise<SessionManager> {
  const s = new SessionManager(`t-${tag}`, dir);
  await s.appendMessage({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    role: "user",
    content: [{ type: "text", text: "hi" }],
  });
  return s;
}

const baseParams = (provider: FakeProvider, session: SessionManager, events: AgentStreamEvent[]) => ({
  provider,
  session,
  model: "fake-1",
  systemPrompt: "test",
  tools: [{ name: "t", description: "", inputSchema: {} }],
  executeToolCall: async () => ({ result: "OK" }),
  onEvent: (e: AgentStreamEvent) => { events.push(e); },
});

describe("stop causes", () => {
  test("completed on plain text end_turn", async () => {
    const provider = new FakeProvider([textTurn("done")]);
    const events: AgentStreamEvent[] = [];
    const outcome = await runAgentLoop(baseParams(provider, await freshSession("done"), events));
    expect(outcome.stopCause).toBe("completed");
    expect(outcome.lastAssistantText).toBe("done");
    expect(outcome.usage.inputTokens).toBeGreaterThan(0);
  });

  test("a tool's endTurn finishes the turn — no follow-up stream, no blank", async () => {
    // cron_report's contract: the tool call IS the agent's last action. The
    // loop must finish after persisting its result, not solicit another turn
    // (the empty follow-up that used to surface as blank_response and discard
    // the captured report).
    const provider = new FakeProvider([
      toolTurn("c", "cron_report", "{}"),
      textTurn("SHOULD NOT REACH"),
    ]);
    const events: AgentStreamEvent[] = [];
    const session = await freshSession("endturn");
    const outcome = await runAgentLoop({
      ...baseParams(provider, session, events),
      executeToolCall: async () => ({ result: "Report recorded.", endTurn: true }),
    });
    expect(outcome.stopCause).toBe("completed");
    expect(provider.i).toBe(1); // never asked for a second turn
    expect(events.some((e) => e.type === "message_end")).toBe(true);
    // The tool_result is persisted, so the tool_use/tool_result pair is intact.
    const messages = await session.getMessages();
    const last = messages[messages.length - 1];
    expect(last.role).toBe("user");
    expect(JSON.stringify(last.content)).toContain("Report recorded.");
  });

  test("provider_error carries the message AND the structured kind", async () => {
    class ErrProvider extends FakeProvider {
      override async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "error", error: "Auth expired", kind: "auth" };
      }
    }
    const events: AgentStreamEvent[] = [];
    const outcome = await runAgentLoop(baseParams(new ErrProvider([]), await freshSession("err"), events));
    expect(outcome.stopCause).toBe("provider_error");
    expect(outcome.error).toBe("Auth expired");
    expect(outcome.errorKind).toBe("auth");
  });

  test("blank_response after the silent re-roll also blanks", async () => {
    class BlankProvider extends FakeProvider {
      calls = 0;
      override async *stream(): AsyncIterable<ProviderEvent> {
        this.calls++;
        yield ME("end_turn");
      }
    }
    const p = new BlankProvider([]);
    const events: AgentStreamEvent[] = [];
    const outcome = await runAgentLoop(baseParams(p, await freshSession("blank"), events));
    expect(outcome.stopCause).toBe("blank_response");
    expect(p.calls).toBe(2); // one free re-roll, then surface
    expect(events.some((e) => e.type === "blank_response")).toBe(true);
  });

  test("max_iterations lands gracefully (tools-off summary persisted)", async () => {
    const provider = new FakeProvider([toolTurn("c", "t", "{}")]); // tools forever
    const events: AgentStreamEvent[] = [];
    const session = await freshSession("iters");
    const outcome = await runAgentLoop({
      ...baseParams(provider, session, events),
      maxIterations: 3,
    });
    expect(outcome.stopCause).toBe("max_iterations");
    expect(outcome.landed).toBe(true);
    expect(provider.landingCalled).toBe(true);
    expect(outcome.lastAssistantText.startsWith("LANDED")).toBe(true);
  });

  test("turn_timeout via maxTurnMs lands gracefully", async () => {
    class SlowToolProvider extends FakeProvider {}
    const provider = new SlowToolProvider([toolTurn("c", "t", "{}")]);
    const events: AgentStreamEvent[] = [];
    const session = await freshSession("deadline");
    const outcome = await runAgentLoop({
      ...baseParams(provider, session, events),
      maxTurnMs: 60,
      executeToolCall: async () => {
        await new Promise((r) => setTimeout(r, 150)); // outlive the deadline
        return { result: "late" };
      },
    });
    expect(outcome.stopCause).toBe("turn_timeout");
    expect(outcome.landed).toBe(true);
  });

  test("aborted when the user signal fires mid-stream", async () => {
    const controller = new AbortController();
    class AbortingProvider extends FakeProvider {
      override async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "text_delta", text: "partial " };
        controller.abort();
        yield { type: "text_delta", text: "more" };
      }
    }
    const events: AgentStreamEvent[] = [];
    const session = await freshSession("abort");
    const outcome = await runAgentLoop({
      ...baseParams(new AbortingProvider([]), session, events),
      signal: controller.signal,
    });
    expect(outcome.stopCause).toBe("aborted");
    // The partial that streamed is persisted with the interruption marker.
    const messages = await session.getMessages();
    const last = messages[messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(JSON.stringify(last.content)).toContain("Interrupted");
  });

  test("loop_detected aborts on a hard repeat streak", async () => {
    // Same tool + same args + same result, every iteration → detector abort.
    const provider = new FakeProvider([toolTurn("r", "t", '{"q":1}')]);
    const events: AgentStreamEvent[] = [];
    const outcome = await runAgentLoop({
      ...baseParams(provider, await freshSession("loopdet"), events),
      maxIterations: 30,
    });
    expect(outcome.stopCause).toBe("loop_detected");
    expect(outcome.detections.length).toBeGreaterThan(0);
  });
});

describe("regressions from the 2026-06 pass", () => {
  test("end_turn arriving WITH tool calls strips them (no orphan tool_use)", async () => {
    class QuirkProvider extends FakeProvider {
      override async *stream(params: ProviderStreamParams): AsyncIterable<ProviderEvent> {
        if (params.tools.length === 0) { yield ME("end_turn"); return; }
        yield { type: "tool_call_start", id: "q1", name: "t" };
        yield { type: "tool_call_delta", id: "q1", args: "{}" };
        yield { type: "tool_call_end", id: "q1" };
        yield ME("end_turn"); // finish_reason "stop" alongside tool_calls
      }
    }
    const events: AgentStreamEvent[] = [];
    const session = await freshSession("quirk");
    let toolRan = false;
    const outcome = await runAgentLoop({
      ...baseParams(new QuirkProvider([]), session, events),
      executeToolCall: async () => { toolRan = true; return { result: "x" }; },
    });
    expect(outcome.stopCause).toBe("completed");
    expect(toolRan).toBe(false); // never executed
    // The persisted assistant message carries NO tool_use blocks.
    const messages = await session.getMessages();
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant.content.some((b) => b.type === "tool_use")).toBe(false);
    // The UI got an error-shaped tool_call_result closing the spinner.
    expect(events.some((e) => e.type === "tool_call_result" && e.isError)).toBe(true);
  });

  test("malformed-but-repairable args reach the tool repaired", async () => {
    const provider = new FakeProvider([
      toolTurn("c1", "t", '```json\n{"path":"MEMORY.md"}\n```'),
      textTurn("done"),
    ]);
    const captured: Array<Record<string, unknown>> = [];
    const events: AgentStreamEvent[] = [];
    await runAgentLoop({
      ...baseParams(provider, await freshSession("repair"), events),
      executeToolCall: async (_n, input) => { captured.push(input); return { result: "ok" }; },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("MEMORY.md");
    expect(captured[0]._parseError).toBeUndefined();
  });
});

describe("provider error plumbing (pure units)", () => {
  test("repairToolArgs core cases", () => {
    expect(repairToolArgs('```json\n{"a":1}\n```')?.input.a).toBe(1);
    expect(repairToolArgs('{"a":1,"b":2,}')?.input.b).toBe(2);
    expect(repairToolArgs("{not json")).toBeNull();
    expect(repairToolArgs("[1,2]")).toBeNull();
  });

  test("rethrowIfAborted rethrows on fired signal / abort-shaped names", () => {
    const ac = new AbortController();
    ac.abort();
    expect(() => rethrowIfAborted(new Error("x"), ac.signal)).toThrow();
    const abortErr = new Error("y");
    abortErr.name = "AbortError";
    expect(() => rethrowIfAborted(abortErr, undefined)).toThrow();
    // Quiet signal + ordinary error → no rethrow.
    expect(() => rethrowIfAborted(new Error("z"), new AbortController().signal)).not.toThrow();
  });

  test("classifyProviderError maps statuses + connection shapes", () => {
    expect(classifyProviderError({ status: 429 })).toBe("rate_limit");
    expect(classifyProviderError({ status: 401 })).toBe("auth");
    expect(classifyProviderError({ status: 503 })).toBe("server");
    expect(classifyProviderError({ status: 400 })).toBe("bad_request");
    const conn = new Error("conn");
    conn.name = "APIConnectionError";
    expect(classifyProviderError(conn)).toBe("network");
    const aborted = new Error("a");
    aborted.name = "AbortError";
    expect(classifyProviderError(aborted)).toBe("aborted");
  });
});
