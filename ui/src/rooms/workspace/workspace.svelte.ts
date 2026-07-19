// Workspace-files room — browse/edit the agent's prompt-source files
// (AGENTS / IDENTITY / SOUL / USER), toggle individual ## sections, and
// preview the assembled system prompt. Ports app.js's workspace-files modal
// against src/server/api-workspace-files.ts.
import { ui, chat, prefs } from '../../lib/state.svelte';

export interface WfSectionSummary {
  heading: string;
  enabled: boolean;
  size: number;
}

export interface WfFileSummary {
  name: string;
  exists: boolean;
  size: number;
  mtime: string;
  sections: WfSectionSummary[];
  toggleable: boolean;
}

export interface WfSection {
  heading: string;
  body: string;
  enabled: boolean;
}

export interface WfFile {
  name: string;
  exists: boolean;
  content: string;
  mtime: string;
  preamble?: string;
  sections: WfSection[];
}

export interface WfPreview {
  stable: string;
  persona: string;
  dynamic: string;
  meta: {
    persona: string | null;
    voiceMode: boolean;
    memoryPackEnabled: boolean;
    tokens: {
      stable: number;
      persona: number;
      dynamic: number;
      standingSkills: number;
      skillsCatalog: number;
      total: number;
    };
  };
}

export const PREVIEW_TAB = 'system-prompt';

export const workspace = $state({
  open: false,
  tab: 'AGENTS.md',
  files: [] as WfFileSummary[],
  file: null as WfFile | null, // loaded content for the active file tab
  loadingFile: false,
  preview: null as WfPreview | null, // cached; invalidated by toggles/saves
  previewError: '',
});

export function openWorkspace(): void {
  workspace.open = true;
  workspace.preview = null;
  void refreshList();
  void switchTab(workspace.tab === PREVIEW_TAB ? 'AGENTS.md' : workspace.tab);
}

export function closeWorkspace(): void {
  workspace.open = false;
  workspace.file = null;
}

const api = (path: string): string =>
  `/api/agents/${encodeURIComponent(ui.currentAgentId ?? '')}${path}`;

export async function refreshList(): Promise<void> {
  try {
    const r = await fetch(api('/workspace-files'));
    const data = (await r.json()) as { files?: WfFileSummary[] };
    workspace.files = data.files ?? [];
  } catch {
    workspace.files = [];
  }
}

export async function switchTab(tab: string): Promise<void> {
  workspace.tab = tab;
  if (tab === PREVIEW_TAB) {
    void loadPreview();
    return;
  }
  workspace.loadingFile = true;
  workspace.file = null;
  try {
    const r = await fetch(api(`/workspace-files/${encodeURIComponent(tab)}`));
    const data = (await r.json()) as WfFile;
    if (workspace.tab !== tab) return; // superseded by a faster tab switch
    workspace.file = data;
  } catch {
    if (workspace.tab === tab) workspace.file = null;
  } finally {
    if (workspace.tab === tab) workspace.loadingFile = false;
  }
}

// Instant-save section toggle (no confirm step). Updates the summary badge
// and invalidates the preview cache — toggles change the next prompt build.
export async function toggleSection(filename: string, heading: string, enabled: boolean): Promise<void> {
  try {
    await fetch(api(`/workspace-files/${encodeURIComponent(filename)}/sections`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sections: { [heading]: enabled } }),
    });
  } finally {
    const summary = workspace.files.find((f) => f.name === filename);
    const s = summary?.sections.find((x) => x.heading === heading);
    if (s) s.enabled = enabled;
    workspace.preview = null;
  }
}

// Preview reflects current send settings: memory pack from prefs, persona
// from personas.json currentState (server fallback), the active session for
// the transition note.
export async function loadPreview(force = false): Promise<void> {
  if (workspace.preview && !force) return;
  workspace.previewError = '';
  try {
    const params = new URLSearchParams();
    if (!prefs.memoryPack) params.set('memoryPack', 'off');
    if (chat.sessionId) params.set('sessionId', chat.sessionId);
    const r = await fetch(api(`/system-prompt-preview?${params}`));
    const data = (await r.json()) as WfPreview & { error?: string };
    if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
    workspace.preview = data;
  } catch (e) {
    workspace.preview = null;
    workspace.previewError = e instanceof Error ? e.message : String(e);
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}
