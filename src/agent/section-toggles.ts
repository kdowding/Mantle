import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

// Files whose `## sections` can be toggled on/off via the in-app workspace
// editor. MEMORY.md is excluded because it tends to be a flat pinned-fact
// list, not section-structured. CLAUDE.md is excluded because it governs
// Claude Code — not the agent's identity surface.
export const TOGGLEABLE_FILES = [
  "AGENTS.md",
  "IDENTITY.md",
  "SOUL.md",
  "USER.md",
] as const;

export type ToggleableFilename = typeof TOGGLEABLE_FILES[number];

export function isToggleableFilename(name: string): name is ToggleableFilename {
  return (TOGGLEABLE_FILES as readonly string[]).includes(name);
}

// The full personality-file surface the systems-deck Personality tab manages:
// the four toggleable identity files plus MEMORY.md (a flat pinned-fact list —
// editable but NOT section-toggleable) and CALL.md (the lean realtime-call
// persona, used ALONE on a call). Section toggles still apply ONLY to
// TOGGLEABLE_FILES; this wider set gates raw read/write + create-from-template.
export const PERSONALITY_FILES = [
  "AGENTS.md",
  "IDENTITY.md",
  "SOUL.md",
  "USER.md",
  "MEMORY.md",
  "CALL.md",
] as const;

export type PersonalityFilename = typeof PERSONALITY_FILES[number];

export function isPersonalityFile(name: string): name is PersonalityFilename {
  return (PERSONALITY_FILES as readonly string[]).includes(name);
}

export interface ParsedSection {
  heading: string;   // text after the leading `## `, trimmed
  body: string;      // includes the `## heading` line + content until next `##` or EOF
}

export interface ParsedFile {
  preamble: string;        // content before the first `##` (always-on)
  sections: ParsedSection[];
}

// ToggleMap shape on disk:
//   {
//     "AGENTS.md": { "Section Heading": false, ... },
//     "SOUL.md":   { "Voice & Vibe": false, ... },
//     ...
//   }
// Missing file keys → all sections enabled. Missing section keys within a
// file → that section is enabled (default-on). Only `false` values disable.
export type ToggleMap = Record<string, Record<string, boolean>>;

const TOGGLE_FILENAME = "section-toggles.json";

// Splits a markdown file into preamble + ## sections. Preamble = everything
// before the first `## ` line (including a one-line summary, frontmatter
// stripped earlier, etc). Each section's body retains its `## heading` line
// so reassembly is a straight join. Trailing whitespace is preserved within
// section bodies so user-authored line breaks survive a round-trip.
export function parseFileSections(content: string): ParsedFile {
  const lines = content.split(/\r?\n/);
  const preambleLines: string[] = [];
  const sections: ParsedSection[] = [];
  let current: { heading: string; body: string[] } | null = null;

  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      if (current) {
        sections.push({ heading: current.heading, body: current.body.join("\n") });
      }
      current = { heading: match[1].trim(), body: [line] };
    } else if (current) {
      current.body.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  if (current) {
    sections.push({ heading: current.heading, body: current.body.join("\n") });
  }

  return {
    preamble: preambleLines.join("\n").replace(/\s+$/, ""),
    sections,
  };
}

// Returns the file content with all sections whose heading is in
// `disabledHeadings` removed. Preamble always passes through. If no
// sections are disabled, returns the input verbatim (no parse round-trip
// cost in the common case).
export function filterFileContent(
  content: string,
  disabledHeadings: Set<string>,
): string {
  if (disabledHeadings.size === 0) return content;
  const parsed = parseFileSections(content);
  // Fast path: no sections at all → nothing to filter, return as-is.
  if (parsed.sections.length === 0) return content;
  const enabled = parsed.sections.filter((s) => !disabledHeadings.has(s.heading));
  // Join: preamble + each enabled section body. Sections already start
  // with `## heading\n`, so we join with a blank line between them.
  const parts: string[] = [];
  if (parsed.preamble) parts.push(parsed.preamble);
  for (const s of enabled) parts.push(s.body.replace(/\s+$/, ""));
  return parts.join("\n\n");
}

export function loadToggleMap(workspacePath: string): ToggleMap {
  const path = resolve(workspacePath, TOGGLE_FILENAME);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as ToggleMap;
    }
    return {};
  } catch {
    return {};
  }
}

export function saveToggleMap(workspacePath: string, map: ToggleMap): void {
  const path = resolve(workspacePath, TOGGLE_FILENAME);
  // Drop empty per-file objects and false-only normalize: storage is
  // monotonic (only `false` matters; missing = on), so we can prune
  // `true` entries to keep the file small and readable.
  const pruned: ToggleMap = {};
  for (const [filename, entries] of Object.entries(map)) {
    const offEntries: Record<string, boolean> = {};
    for (const [heading, enabled] of Object.entries(entries)) {
      if (enabled === false) offEntries[heading] = false;
    }
    if (Object.keys(offEntries).length > 0) pruned[filename] = offEntries;
  }
  writeFileSync(path, JSON.stringify(pruned, null, 2), "utf-8");
}

// Drop entries from a file's toggle map whose heading no longer exists in
// the current file content. Called after a raw-file save so renamed /
// removed sections don't leave orphan entries lying around.
export function reconcileFileToggles(
  map: ToggleMap,
  filename: string,
  currentSectionHeadings: string[],
): ToggleMap {
  const fileMap = map[filename];
  if (!fileMap) return map;
  const valid = new Set(currentSectionHeadings);
  const next: Record<string, boolean> = {};
  for (const [heading, enabled] of Object.entries(fileMap)) {
    if (valid.has(heading)) next[heading] = enabled;
  }
  return { ...map, [filename]: next };
}

// Convenience: build the disabled-set for a single file from the toggle
// map. Used by the prompt-builder filter step.
export function disabledHeadingsFor(map: ToggleMap, filename: string): Set<string> {
  const fileMap = map[filename];
  if (!fileMap) return new Set();
  const out = new Set<string>();
  for (const [heading, enabled] of Object.entries(fileMap)) {
    if (enabled === false) out.add(heading);
  }
  return out;
}
