// Tool-catalog shared lib — the /api/tools fetch + the capability grouping,
// promoted out of rooms/tools when the cron tool-picker became a second
// consumer (UI promotion rule). The tools room re-exports these so its own
// components are unchanged; the cron picker imports them here directly.

export interface ToolInfo {
  name: string;
  description: string;
  estTokens: number;
  source: string;
  // "agent" = advertised to the live chat agent; "internal" = registered but
  // hidden by the system (raw englyph_* + remember + recall_source). Internal
  // tools aren't user-selectable — they're plumbing. From /api/tools?agentId=.
  visibility: 'agent' | 'internal';
  // In this agent's disabledTools gate (a hard per-agent capability gate).
  disabled: boolean;
}

export interface ToolGroup {
  label: string;
  items: ToolInfo[];
  tokens: number;
}

export interface ToolCatalog {
  tools: ToolInfo[];
  // The read-only safe-set a mechanical/aware cron run gets (cron/presets.ts).
  cronSafeTools: string[];
}

// Fetch the agent's tool catalog from /api/tools: the normalized tool list +
// the cron safe-set. Caller owns staleness handling (compare agentId after).
export async function fetchToolCatalog(agentId: string | null): Promise<ToolCatalog> {
  const q = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
  const res = await fetch(`/api/tools${q}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { tools?: Array<Partial<ToolInfo>>; cronSafeTools?: string[] };
  const tools = (data.tools ?? []).map((t): ToolInfo => ({
    name: t.name ?? '?',
    description: t.description ?? '',
    estTokens: t.estTokens ?? 0,
    source: t.source ?? 'core',
    visibility: t.visibility === 'internal' ? 'internal' : 'agent',
    disabled: t.disabled ?? false,
  }));
  return { tools, cronSafeTools: data.cronSafeTools ?? [] };
}

// Display grouping: core tools bucket into curated capability groups; MCP /
// englyph / room tools group by their stamped provenance. Unknown core names
// land in "other" so a newly added tool is never invisible.
const CORE_GROUP_OF: Record<string, string> = {
  read_file: 'filesystem', write_file: 'filesystem', edit_file: 'filesystem',
  list_directory: 'filesystem', glob_files: 'filesystem', grep_files: 'filesystem',
  bash: 'shell',
  web_fetch: 'web',
  recall: 'memory', recall_history: 'memory', recall_area: 'memory',
  recall_source: 'memory', expand_memory: 'memory', memory_status: 'memory', remember: 'memory',
  sessions_list: 'sessions', sessions_history: 'sessions', render_session_markdown: 'sessions',
  attach_local_file: 'attachments', attach_url_file: 'attachments',
  spawn_agent: 'agents',
  cron_jobs: 'automation',
  englyph_research_async: 'research',
};
const CORE_GROUP_ORDER = [
  'filesystem', 'shell', 'web', 'memory', 'sessions', 'attachments', 'agents', 'automation', 'research', 'other',
];

export function groupTools(list: ToolInfo[]): ToolGroup[] {
  const buckets = new Map<string, ToolInfo[]>();
  for (const t of list) {
    const label = t.source === 'core'
      ? CORE_GROUP_OF[t.name] ?? 'other'
      : t.source.startsWith('mcp:') || t.source.startsWith('room:')
        ? t.source.slice(t.source.indexOf(':') + 1)
        : t.source; // "englyph"
    const arr = buckets.get(label) ?? [];
    arr.push(t);
    buckets.set(label, arr);
  }
  const out: ToolGroup[] = [];
  const take = (label: string): void => {
    const items = buckets.get(label);
    if (!items?.length) return;
    buckets.delete(label);
    out.push({ label, items, tokens: items.reduce((s, t) => s + t.estTokens, 0) });
  };
  for (const label of CORE_GROUP_ORDER) take(label);
  for (const label of [...buckets.keys()].sort()) take(label); // englyph + MCP servers + rooms
  return out;
}
