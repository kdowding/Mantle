// Locks the chat hide policy — the exact contract behind "why does the Tools
// page show englyph_* AND the memory tools": the raw englyph_* surface plus
// `remember` + `recall_source` are registered but INTERNAL (not advertised to
// the live agent), while the curated recall_* wrappers ARE the agent's memory
// surface. Display (/api/tools visibility) and enforcement (ws.ts toolFilter)
// both read this, so this test is what keeps them from drifting again.

import { describe, test, expect } from "bun:test";
import { isHiddenFromChat, chatToolHidden, MEMORY_WRAPPER_NAMES } from "./chat-tool-surface.js";

describe("chat hide policy", () => {
  test("raw englyph_* tools are internal", () => {
    for (const n of ["englyph_search", "englyph_add_drawer", "englyph_gather", "englyph_status", "englyph_search_batch"]) {
      expect(isHiddenFromChat(n)).toBe(true);
    }
  });

  test("remember + recall_source are internal (archivist / internal callers only)", () => {
    expect(isHiddenFromChat("remember")).toBe(true);
    expect(isHiddenFromChat("recall_source")).toBe(true);
  });

  test("the curated recall_* surface IS the agent's memory surface", () => {
    for (const n of ["recall", "recall_history", "recall_area", "expand_memory", "memory_status"]) {
      expect(isHiddenFromChat(n)).toBe(false);
    }
  });

  test("non-memory tools are agent-visible", () => {
    for (const n of ["read_file", "bash", "web_fetch", "cron_jobs", "spawn_agent", "music_generate"]) {
      expect(isHiddenFromChat(n)).toBe(false);
    }
  });

  test("MANTLE_DISABLE_MEMORY_TOOLS hides the WHOLE memory surface, nothing else", () => {
    expect(chatToolHidden("recall", false)).toBe(false); // normally visible
    for (const n of MEMORY_WRAPPER_NAMES) {
      expect(chatToolHidden(n, true)).toBe(true); // flag hides every wrapper
    }
    expect(chatToolHidden("bash", true)).toBe(false); // non-memory tools untouched
  });
});
