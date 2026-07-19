// The live chat agent's memory surface is the registry MINUS a system
// deny-list. This module is the SINGLE source of that policy so enforcement
// (ws.ts's toolFilter) and display (/api/tools' `visibility`) can never drift —
// the drift between "what the registry holds" and "what the agent sees" is
// exactly what made the Tools page misreport the memory surface.
//
// Hidden from chat, always:
//   - the raw `englyph_*` MCP tools — the recall_* / memory_status wrappers
//     cover retrieval in companion language, and the agent can't write/delete;
//   - `remember` — memory authoring is out-of-band, not the live agent's job;
//   - `recall_source` — the source-retrieval feature is being redone.
// These stay REGISTERED (the pre-inference memory pack calls them directly via
// registry.execute); they're just not advertised to the live agent.

// The full set of companion memory wrappers (curated recall_* surface + the
// internal-only ones). Used by the MANTLE_DISABLE_MEMORY_TOOLS pack-isolation
// path, which hides the WHOLE memory surface from chat.
export const MEMORY_WRAPPER_NAMES: ReadonlySet<string> = new Set([
  "remember", "recall", "recall_source", "recall_history", "recall_area",
  "expand_memory", "memory_status",
]);

// Wrappers that are registered but never shown to the live chat agent.
const ALWAYS_HIDDEN: ReadonlySet<string> = new Set(["remember", "recall_source"]);

// True when a tool is part of the always-hidden system surface (independent of
// the dev pack-isolation flag). This is the stable policy the Tools page marks
// as "internal — not agent-visible".
export function isHiddenFromChat(name: string): boolean {
  return name.startsWith("englyph_") || ALWAYS_HIDDEN.has(name);
}

// The effective per-turn hide decision: the always-hidden surface, plus —
// when MANTLE_DISABLE_MEMORY_TOOLS=1 (pre-inference-pack isolation testing) —
// the entire memory-wrapper surface.
export function chatToolHidden(name: string, disableMemoryTools: boolean): boolean {
  if (isHiddenFromChat(name)) return true;
  if (disableMemoryTools && MEMORY_WRAPPER_NAMES.has(name)) return true;
  return false;
}
