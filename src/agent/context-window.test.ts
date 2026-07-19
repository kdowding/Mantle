// resolveContextWindow — the gauge's ceiling resolver. The branching is
// load-bearing for a correct gauge: keying on the PROVIDER name (so the
// Codex/API gpt-5.x window split is right), the per-model override winning
// over the provider default, and the local fallback when the registry has no
// entry. Pure over a minimal config fixture — no real registry on disk.
import { describe, test, expect } from "bun:test";
import { resolveContextWindow, effectiveCompactionThreshold } from "./compaction.js";
import type { MantleConfig } from "../config/schema.js";

const cfg = (over?: { models?: Record<string, number>; def?: number; localCtx?: number; fraction?: number }): MantleConfig =>
  ({
    // A path with no registry.json — loadRegistry returns empty, so the local
    // branch exercises the defaults.ctxSize → defaultContextWindow fallback.
    basePath: "/nonexistent-mantle-context-window-test",
    session: {
      modelContextWindows: over?.models ?? { "grok-4.3": 256000, "gpt-5.4": 400000 },
      defaultContextWindow: over?.def ?? 200000,
      compactionFraction: over?.fraction ?? 0.6,
    },
    localModels: { modelsDir: "models", defaults: { ctxSize: over?.localCtx ?? 0 } },
  }) as unknown as MantleConfig;

describe("resolveContextWindow", () => {
  test("per-model override wins for a listed model", () => {
    expect(resolveContextWindow("grok", "grok-4.3", cfg())).toBe(256000);
  });

  test("provider default applies for an unlisted model of that vendor", () => {
    expect(resolveContextWindow("claude", "claude-haiku-4-5-20251001", cfg())).toBe(200000);
    expect(resolveContextWindow("grok", "grok-9-unlisted", cfg())).toBe(256000);
    expect(resolveContextWindow("openai", "gpt-9-unlisted", cfg())).toBe(400000);
  });

  test("codex serves 272k except for the 128k spark model", () => {
    expect(resolveContextWindow("openai-codex", "gpt-5.6-terra", cfg())).toBe(272000);
    expect(resolveContextWindow("openai-codex", "gpt-5.3-codex-spark", cfg())).toBe(128000);

    // gpt-5.4 is 400k in the map (the ChatGPT-API value) — the Codex backend
    // must NOT read it.
    expect(resolveContextWindow("openai-codex", "gpt-5.4", cfg())).toBe(272000);
  });

  test("grok-build resolves per model: the map for known ids, 512k for unknown", () => {
    // Both grok-build ids live in the per-model map ("grok-build" 512k,
    // grok-4.5 500k) — unlike codex, the subscription proxy has no
    // shared-id-with-a-smaller-window case, so the map wins.
    expect(resolveContextWindow("grok-build", "grok-build", cfg({ models: { "grok-build": 512000, "grok-4.5": 500000 } }))).toBe(512000);
    expect(resolveContextWindow("grok-build", "grok-4.5", cfg({ models: { "grok-build": 512000, "grok-4.5": 500000 } }))).toBe(500000);
    // An id missing from the map falls back to the lineup default, not the
    // global default — the proxy's documented ceiling.
    expect(resolveContextWindow("grok-build", "grok-build", cfg())).toBe(512000);
  });

  test("an unknown provider falls back to the global default", () => {
    expect(resolveContextWindow("mystery", "whatever", cfg({ def: 123456 }))).toBe(123456);
  });

  test("local with no registry entry uses the local default ctx, then the global default", () => {
    expect(resolveContextWindow("local", "some-gguf", cfg({ localCtx: 8192 }))).toBe(8192);
    expect(resolveContextWindow("local", "some-gguf", cfg({ localCtx: 0, def: 200000 }))).toBe(200000);
  });
});

describe("effectiveCompactionThreshold", () => {
  // The contract that drifted before: compaction must fire at the configured
  // FRACTION of the window, per model — not a fixed token count that reads as
  // 60% on one window and 44% on another.
  test("is the configured fraction of the resolved window, per model", () => {
    expect(effectiveCompactionThreshold(200000, cfg())).toBe(120000); // Claude — was the old fixed 120k
    expect(effectiveCompactionThreshold(272000, cfg())).toBe(163200); // Codex — used to read 44% at 120k
    expect(effectiveCompactionThreshold(512000, cfg())).toBe(307200); // grok-build
    expect(effectiveCompactionThreshold(8192, cfg())).toBe(4915);     // a local 8K window
  });

  test("honors a non-default fraction", () => {
    expect(effectiveCompactionThreshold(200000, cfg({ fraction: 0.8 }))).toBe(160000);
  });
});
