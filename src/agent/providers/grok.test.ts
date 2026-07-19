// mapReasoningEffort — the xAI effort clamp shared by the API provider
// (grok.ts) and the Build subscription provider (grok-build.ts). The contract
// worth pinning: the floor is what "off"/unset maps to (grok-4.5 can't disable
// reasoning and DEFAULTS TO HIGH when the param is omitted, so an explicit
// floor value must always go out), and the upper levels clamp to "high" (the
// configurable models' ceiling).
import { describe, test, expect } from "bun:test";
import { mapReasoningEffort } from "./grok.js";

describe("mapReasoningEffort", () => {
  test("off/unset map to the model's floor", () => {
    expect(mapReasoningEffort("off", "low")).toBe("low");
    expect(mapReasoningEffort(undefined, "low")).toBe("low");
    expect(mapReasoningEffort("off", "none")).toBe("none");
    expect(mapReasoningEffort(undefined, "none")).toBe("none");
  });

  test("low/medium pass through regardless of floor", () => {
    expect(mapReasoningEffort("low", "none")).toBe("low");
    expect(mapReasoningEffort("low", "low")).toBe("low");
    expect(mapReasoningEffort("medium", "low")).toBe("medium");
  });

  test("high/xhigh/max clamp to high — the configurable models' ceiling", () => {
    expect(mapReasoningEffort("high", "low")).toBe("high");
    expect(mapReasoningEffort("xhigh", "low")).toBe("high");
    expect(mapReasoningEffort("max", "none")).toBe("high");
  });
});
