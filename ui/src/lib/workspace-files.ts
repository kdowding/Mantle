// Shared REST client for an agent's personality / workspace files. Both the
// quick-toggle modal (rooms/workspace) and the Personality deck tab
// (rooms/personality) go through here, so the two can't drift on request
// shapes. The server is src/server/api-workspace-files.ts.

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
  // Whether `## section` toggles apply (the four identity files). MEMORY/CALL
  // are editable but not section-toggleable.
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

const base = (agentId: string): string =>
  `/api/agents/${encodeURIComponent(agentId)}/workspace-files`;

export async function listWorkspaceFiles(agentId: string): Promise<WfFileSummary[]> {
  const r = await fetch(base(agentId));
  const data = (await r.json()) as { files?: WfFileSummary[] };
  return data.files ?? [];
}

export async function readWorkspaceFile(agentId: string, file: string): Promise<WfFile> {
  const r = await fetch(`${base(agentId)}/${encodeURIComponent(file)}`);
  return (await r.json()) as WfFile;
}

export async function writeWorkspaceFile(
  agentId: string,
  file: string,
  content: string,
): Promise<void> {
  const r = await fetch(`${base(agentId)}/${encodeURIComponent(file)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) {
    const data = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `HTTP ${r.status}`);
  }
}

export async function setWorkspaceSections(
  agentId: string,
  file: string,
  sections: Record<string, boolean>,
): Promise<void> {
  await fetch(`${base(agentId)}/${encodeURIComponent(file)}/sections`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sections }),
  });
}

// Create a missing file from its template (rendered for this agent) and return
// the new content + section metadata so the editor can open it immediately.
export async function scaffoldWorkspaceFileApi(agentId: string, file: string): Promise<WfFile> {
  const r = await fetch(`${base(agentId)}/${encodeURIComponent(file)}/scaffold`, { method: 'POST' });
  const data = (await r.json().catch(() => ({}))) as WfFile & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}
