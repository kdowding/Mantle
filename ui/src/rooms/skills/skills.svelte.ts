// Skills room state + REST — the per-agent skill list with enable/disable
// overrides. Port of app.js's loadAgentSkills/renderSkills/toggleSkill (the
// one old-UI surface the rebuild had missed entirely).
import { ui } from '../../lib/state.svelte';

export interface AgentSkill {
  name: string;
  description?: string;
  source: 'global' | 'agent';
  // On-disk directory — the stable address the file CRUD endpoints key on
  // (frontmatter name may differ from the dir name).
  dir: string;
  always?: boolean;
  enabled: boolean;
  globalEnabled: boolean;
  agentOverride?: 'enabled' | 'disabled' | null;
}

export const skills = $state({
  open: false,
  list: [] as AgentSkill[],
  loading: false,
  error: null as string | null,
});

export async function loadSkills(): Promise<void> {
  const agentId = ui.currentAgentId;
  if (!agentId) return;
  skills.loading = true;
  try {
    const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/skills`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = (await r.json()) as { skills?: AgentSkill[] };
    if (agentId !== ui.currentAgentId) return; // superseded by a newer switch
    skills.list = data.skills ?? [];
    skills.error = null;
  } catch (e) {
    if (agentId !== ui.currentAgentId) return;
    skills.list = [];
    skills.error = e instanceof Error ? e.message : String(e);
  } finally {
    skills.loading = false;
  }
}

// ── Skill file CRUD (the deck editor) ───────────────────────────────────────

export interface SkillFileRef {
  scope: 'global' | 'agent';
  dir: string;
}

function fileQuery(ref: SkillFileRef): string {
  const q = new URLSearchParams({ scope: ref.scope, dir: ref.dir });
  if (ref.scope === 'agent' && ui.currentAgentId) q.set('agentId', ui.currentAgentId);
  return q.toString();
}

export async function readSkillFile(ref: SkillFileRef): Promise<string> {
  const r = await fetch(`/api/skills/file?${fileQuery(ref)}`);
  const data = (await r.json().catch(() => ({}))) as { content?: string; error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  // Normalize CRLF→LF: a <textarea> reports LF regardless of the on-disk line
  // endings, so a Windows (CRLF) file would otherwise read as permanently dirty
  // (buffer LF ≠ saved CRLF) and produce noisy diffs. The save re-writes LF.
  return (data.content ?? '').replace(/\r\n/g, '\n');
}

export async function writeSkillFile(ref: SkillFileRef, content: string): Promise<void> {
  const r = await fetch('/api/skills/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope: ref.scope,
      dir: ref.dir,
      content,
      ...(ref.scope === 'agent' ? { agentId: ui.currentAgentId } : {}),
    }),
  });
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  await loadSkills(); // discovery sees the change next turn; the UI sees it now
}

export async function deleteSkillFile(ref: SkillFileRef): Promise<void> {
  const r = await fetch(`/api/skills/file?${fileQuery(ref)}`, { method: 'DELETE' });
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  await loadSkills();
}

// Override state machine (matches the old UI + the server's resolution
// precedence): turning ON a globally-disabled skill needs an 'enabled'
// override; turning OFF is always an explicit 'disabled'; turning ON a
// globally-enabled skill just clears the override ('inherit').
export async function toggleSkill(skill: AgentSkill, on: boolean): Promise<void> {
  const agentId = ui.currentAgentId;
  if (!agentId) return;
  const state = on && !skill.globalEnabled ? 'enabled' : !on ? 'disabled' : 'inherit';
  try {
    await fetch(`/api/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skill.name)}/toggle`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    });
  } finally {
    await loadSkills(); // server is the source of truth either way
  }
}
