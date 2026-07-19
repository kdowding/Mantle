// Agent CRUD room — modal state + shared helpers. The Svelte port of
// ui/agent-modals.js. App's touches: mount <AgentsHost/>, the sidebar
// "+ New agent" / per-card ✎ triggers writing to `agentModals`.
import { ui } from '../../lib/state.svelte';

export const agentModals = $state({
  create: false,
  editId: null as string | null,
  deleteId: null as string | null, // stacks over the edit modal
});

// The englyphPath to offer under "Share with existing agents": the most-common
// path among existing agents, tie-broken by first-seen. Null when none is set.
export function detectSharedEnglyphPath(): string | null {
  const counts = new Map<string, number>();
  for (const a of ui.agents) {
    if (!a.englyphPath) continue;
    counts.set(a.englyphPath, (counts.get(a.englyphPath) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [path, count] of counts) {
    if (count > bestCount) {
      best = path;
      bestCount = count;
    }
  }
  return best;
}

export type EnglyphMode = 'isolated' | 'share' | 'custom';

// Resolve the englyphPath to send from the picker state. `forEdit` sends null
// for isolated (tells the backend to delete the field); create omits it.
export function resolveEnglyphPath(
  mode: EnglyphMode,
  customPath: string,
  sharePath: string | null,
  forEdit: boolean,
): { ok: true; value: string | null | undefined } | { ok: false; error: string } {
  if (mode === 'share') return { ok: true, value: sharePath ?? (forEdit ? null : undefined) };
  if (mode === 'custom') {
    const custom = customPath.trim();
    if (!custom) return { ok: false, error: 'Custom englyph path is required when "Custom path" is selected.' };
    return { ok: true, value: custom };
  }
  return { ok: true, value: forEdit ? null : undefined };
}
