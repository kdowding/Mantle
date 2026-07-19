// Tools room — the per-agent tool surface made VISIBLE and MANAGEABLE: every
// registered tool, where it came from (core / englyph / mcp:<server> / room:*),
// what advertising it costs (estTokens), whether the live agent actually sees
// it (visibility), and whether the user has disabled it (disabled). Disable is
// a hard per-agent capability gate enforced at the front door — see
// src/agent/triggered-turn.ts (applyToolSurface).
//
// The catalog fetch + capability grouping live in lib/toolCatalog (shared with
// the cron tool-picker); re-exported here so this room's components are
// unchanged.
import { ui } from '../../lib/state.svelte';
import { fetchToolCatalog, groupTools, type ToolInfo, type ToolGroup } from '../../lib/toolCatalog';

export { groupTools };
export type { ToolInfo, ToolGroup };

export const tools = $state({
  open: false,
  list: [] as ToolInfo[],
  loadedAgentId: null as string | null,
  loading: false,
  error: null as string | null,
});

export async function loadTools(agentId: string | null, force = false): Promise<void> {
  if (tools.loading) return;
  if (!force && tools.loadedAgentId === agentId && tools.list.length > 0) return;
  tools.loading = true;
  try {
    const data = await fetchToolCatalog(agentId);
    if (agentId !== ui.currentAgentId && agentId !== null) return; // superseded by a newer switch
    tools.list = data.tools;
    tools.loadedAgentId = agentId;
    tools.error = null;
  } catch (e) {
    tools.error = e instanceof Error ? e.message : String(e);
  } finally {
    tools.loading = false;
  }
}

// Batch enable/disable (a single tool is a 1-element batch; a group is its
// member names). Optimistic — the server is the source of truth on failure.
export async function toggleTools(agentId: string, names: string[], disabled: boolean): Promise<void> {
  if (!agentId || names.length === 0) return;
  const set = new Set(names);
  for (const t of tools.list) if (set.has(t.name) && t.visibility === 'agent') t.disabled = disabled;
  try {
    const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/tools/disable`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names, disabled }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    tools.error = e instanceof Error ? e.message : String(e);
    await loadTools(agentId, true); // re-sync to the server's truth
  }
}
