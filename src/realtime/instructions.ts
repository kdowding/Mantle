// Compose the system-prompt instructions string for an xAI realtime
// call session.
//
// Preferred path: workspaces/<agent>/CALL.md — a distilled call-mode
// personality file. Used ALONE (plus the CALL_MODE_PROMPT footer) so
// the call prompt stays focused on voice-shaped personality rather
// than re-injecting AGENTS / SOUL / USER / MEMORY / skills / tool
// conventions, none of which apply in a no-tools voice conversation.
//
// Fallback path: if CALL.md is missing, falls back to the full chat
// system prompt (buildSystemPrompt). A one-line warning is logged so
// the user knows to create CALL.md for a leaner prompt. Existing
// agents without CALL.md keep working — they just get the heavier
// prompt that they were getting before this change.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { buildSystemPrompt, type PersonaProfile } from "../agent/prompt-builder.js";

// Spoken-conversation guidance for two-way realtime calls. Differs from
// the existing VOICE_MODE_PROMPT in prompt-builder.ts (which targets
// one-way TTS over chat): assumes the user is actively listening and
// can barge in any moment, so calls for shorter natural turns and
// explicit avoidance of read-aloud-hostile content.
const CALL_MODE_PROMPT = `# Call Mode

You're on a live voice call right now. The user is speaking to you and listening to your reply in real time. They can interrupt you at any moment — keep your responses short and natural, more like an actual conversation than a written reply.

Talk the way you talk, not the way you write:
- Short sentences. Natural pauses driven by punctuation.
- No markdown, no headers, no code blocks, no bullet lists. None of it speaks.
- Skip "e.g.", "i.e.", "etc." — say "for example", "I mean", "and so on".
- Don't read URLs, file paths, or long ID strings aloud. If you need to share one, say so briefly.
- If you'd normally write a code block or a long structured reply, instead offer the gist verbally and tell the user you'll send the details in chat afterward.

If the user interrupts you mid-sentence, stop and listen — don't try to finish your sentence.

Stay yourself — the persona above still applies. Call mode shapes how you reply, not who you are.`;

export interface BuildCallInstructionsOptions {
  workspacePath: string;
  persona?: { name: string; profile: PersonaProfile };
  memoryPack?: string;
}

// Strip YAML frontmatter from a markdown file. Matches the helper in
// prompt-builder.ts — duplicated here so this module stays focused.
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("---", 3);
  if (end === -1) return content;
  return content.slice(end + 3).trim();
}

// Load workspaces/<agent>/CALL.md if present and non-empty. Returns
// null on missing file, empty file (after stripping frontmatter), or
// any read error. Caller decides what to fall back to.
function loadCallFile(workspacePath: string): string | null {
  const callPath = resolve(workspacePath, "CALL.md");
  if (!existsSync(callPath)) return null;
  try {
    const raw = readFileSync(callPath, "utf-8");
    const content = stripFrontmatter(raw).trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

// Emit the one-time warning that CALL.md is missing. Keyed by workspace
// path so each agent only warns once per process lifetime (chatty
// per-call warnings on every restart would obscure real issues).
const warnedWorkspaces = new Set<string>();
function warnMissingCallFile(workspacePath: string): void {
  if (warnedWorkspaces.has(workspacePath)) return;
  warnedWorkspaces.add(workspacePath);
  console.warn(
    `[MANTLE:realtime] CALL.md not found at ${resolve(workspacePath, "CALL.md")} — ` +
    `falling back to full chat system prompt. Create CALL.md in the workspace for a ` +
    `focused call-mode personality (distilled voice/tone, no AGENTS/SOUL/USER baggage).`,
  );
}

// Prefer CALL.md when present. Falls back to the full chat system
// prompt (legacy behavior) when it isn't, so existing agents keep
// working. The CALL_MODE_PROMPT footer goes last in either path for
// maximum recency weight on conversational style.
export function buildCallInstructions(opts: BuildCallInstructionsOptions): string {
  const parts: string[] = [];

  const callContent = loadCallFile(opts.workspacePath);
  if (callContent) {
    // Lean path: CALL.md is the entire identity. Persona / memory
    // pack are deliberately NOT layered on — if the user wants them
    // in voice, they author them into CALL.md directly. Keeps the
    // call prompt small and predictable.
    parts.push(callContent);
    parts.push(CALL_MODE_PROMPT);
    return parts.join("\n\n---\n\n");
  }

  warnMissingCallFile(opts.workspacePath);

  const prompt = buildSystemPrompt({
    workspacePath: opts.workspacePath,
    persona: opts.persona,
    memoryPack: opts.memoryPack,
    // voiceMode is false: VOICE_MODE_PROMPT targets one-way TTS, not
    // two-way calls. The CALL_MODE_PROMPT below replaces it.
    voiceMode: false,
  });

  if (prompt.stable.trim()) parts.push(prompt.stable);
  if (prompt.persona.trim()) parts.push(prompt.persona);
  if (prompt.dynamic.trim()) parts.push(prompt.dynamic);
  parts.push(CALL_MODE_PROMPT);

  return parts.join("\n\n---\n\n");
}
