import { test, expect } from "bun:test";
import { createMantleStatusTool } from "./mantle-status.js";
import { DEFAULT_CONFIG } from "../../config/schema.js";

// Construct against the shipped defaults with no subsystem managers wired —
// the "fresh install / managers absent" defensive path. We assert shape and
// key markers, not which backends happen to be configured.
const ctx = { agentId: "agent-x", sessionId: "sess-1" };

test("mantle_status defaults to the overview health digest", async () => {
  const tool = createMantleStatusTool(DEFAULT_CONFIG, {});
  const r = await tool.execute({}, ctx);
  expect(r.isError).toBeFalsy();
  expect(r.content).toContain("status overview");
  expect(r.content).toContain("Inference:");
  expect(r.content).toContain("Memory (Englyph):");
  expect(r.content).toContain("Voice (TTS sidecar):");
  expect(r.content).toContain("Agents:");
});

test("mantle_status backends lists the (vendor x mode) catalog", async () => {
  const tool = createMantleStatusTool(DEFAULT_CONFIG, {});
  const r = await tool.execute({ area: "backends" }, ctx);
  expect(r.content).toContain("Inference backends");
  // A couple of stable CATALOG cell ids should always appear.
  expect(r.content).toContain("anthropic/api");
  expect(r.content).toContain("local");
});

test("mantle_status agents reports an empty roster on a fresh config", async () => {
  const tool = createMantleStatusTool(DEFAULT_CONFIG, {});
  const r = await tool.execute({ area: "agents" }, ctx);
  expect(r.content).toContain("No agents");
});

test("mantle_status local reports the runtime state", async () => {
  const tool = createMantleStatusTool(DEFAULT_CONFIG, {});
  const r = await tool.execute({ area: "local" }, ctx);
  expect(r.content).toContain("Local models");
  expect(r.content).toContain("binary");
});
