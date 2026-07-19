// Personality room — state + helpers for the systems-deck Personality tab,
// the home for an agent's persona files (AGENTS / IDENTITY / SOUL / USER /
// MEMORY / CALL). Thin wrappers over lib/workspace-files keyed to the current
// agent; the tab component (PersonalityDeck) owns the editor + assist wiring.
import { ui } from '../../lib/state.svelte';
import { lsGet, lsSet } from '../../lib/storage';
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
  setWorkspaceSections,
  scaffoldWorkspaceFileApi,
  type WfFileSummary,
  type WfFile,
} from '../../lib/workspace-files';

export interface PersonalityFileMeta {
  name: string;   // on-disk filename
  label: string;  // short display label
  blurb: string;  // one-line "what this file is" shown when it's open
}

// The six persona files in system-prompt LOAD-PRIORITY order — mirrors
// prompt-builder.ts WORKSPACE_FILES (AGENTS → SOUL → IDENTITY → USER → MEMORY),
// then CALL.md last: it's the realtime-call-only persona and never loads into the
// chat system prompt. Each blurb says what the file means inside MANTLE.
export const PERSONALITY_FILE_META: PersonalityFileMeta[] = [
  { name: 'AGENTS.md', label: 'Agents', blurb: 'Operating rules, safety boundaries, and judgment - the guardrails for how the agent behaves.' },
  { name: 'SOUL.md', label: 'Soul', blurb: 'Voice, values, and way of being - the personality layer loaded into every chat turn.' },
  { name: 'IDENTITY.md', label: 'Identity', blurb: 'Name, tagline, and one-line purpose - the factual who/what. The first line feeds the profile bar.' },
  { name: 'USER.md', label: 'User', blurb: 'What the agent knows about you - who you are, how you work, what you want.' },
  { name: 'MEMORY.md', label: 'Memory', blurb: 'A small, curated list of pinned facts always in the prompt - working memory, distinct from the larger Englyph pool.' },
  { name: 'CALL.md', label: 'Call', blurb: 'The realtime-call persona, used alone on a voice call - a lean paragraph, no markdown or stage directions.' },
];

export const personality = $state({
  files: [] as WfFileSummary[],
  loading: false,
});

// Sticky editor view mode — a real toggle, not a per-file default: whichever
// the user picks, every file they open honors it (sections for toggleable
// files, raw otherwise) instead of snapping back. Persisted best-effort so it
// survives a deck reopen and a reload.
export type PersonalityView = 'sections' | 'raw';
const VIEW_KEY = 'mantle.personality.view';
export const personalityView = $state<{ mode: PersonalityView }>({
  mode: lsGet(VIEW_KEY) === 'raw' ? 'raw' : 'sections',
});
export function setPersonalityView(mode: PersonalityView): void {
  personalityView.mode = mode;
  lsSet(VIEW_KEY, mode);
}

export async function loadPersonalityFiles(): Promise<void> {
  const agentId = ui.currentAgentId;
  if (!agentId) {
    personality.files = [];
    return;
  }
  personality.loading = true;
  try {
    personality.files = await listWorkspaceFiles(agentId);
  } catch {
    personality.files = [];
  } finally {
    personality.loading = false;
  }
}

export function readPersonalityFile(file: string): Promise<WfFile> {
  return readWorkspaceFile(ui.currentAgentId ?? '', file);
}

export function writePersonalityFile(file: string, content: string): Promise<void> {
  return writeWorkspaceFile(ui.currentAgentId ?? '', file, content);
}

export function togglePersonalitySection(file: string, heading: string, enabled: boolean): Promise<void> {
  return setWorkspaceSections(ui.currentAgentId ?? '', file, { [heading]: enabled });
}

export function createPersonalityFile(file: string): Promise<WfFile> {
  return scaffoldWorkspaceFileApi(ui.currentAgentId ?? '', file);
}
