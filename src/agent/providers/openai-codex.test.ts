// Codex reasoning and fast-tier capability maps are pinned to the 2026-07-17
// catalog + live Responses probes. Request construction consumes these helpers;
// the unit surface stays token-free and deterministic.
import { describe, expect, test } from "bun:test";
import {
  CODEX_FAST_MODELS,
  mapCodexReasoningEffort,
} from "./openai-codex.js";

describe("mapCodexReasoningEffort", () => {
  test("omits an absent preference and maps off to the low floor", () => {
    expect(mapCodexReasoningEffort(undefined, "gpt-5.6-terra")).toBeUndefined();
    expect(mapCodexReasoningEffort("off", "gpt-5.6-terra")).toBe("low");
  });

  test("passes max through on every gpt-5.6 model", () => {
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(mapCodexReasoningEffort("max", model)).toBe("max");
    }
  });

  test("clamps max to high on older models", () => {
    expect(mapCodexReasoningEffort("max", "gpt-5.4")).toBe("high");
    expect(mapCodexReasoningEffort("max", "gpt-5.5")).toBe("high");
  });

  test("passes low through xhigh unchanged", () => {
    for (const level of ["low", "medium", "high", "xhigh"] as const) {
      expect(mapCodexReasoningEffort(level, "gpt-5.6-terra")).toBe(level);
    }
  });
});

describe("CODEX_FAST_MODELS", () => {
  test("matches the catalog's priority-tier membership", () => {
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"]) {
      expect(CODEX_FAST_MODELS.has(model)).toBe(true);
    }
    for (const model of ["gpt-5.4-mini", "gpt-5.3-codex-spark"]) {
      expect(CODEX_FAST_MODELS.has(model)).toBe(false);
    }
  });
});
