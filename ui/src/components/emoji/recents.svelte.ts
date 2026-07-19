// Recent-emoji memory, shared by the picker grid and the shortcode
// autocomplete. Persisted to the same key the vanilla UI used.
import { lsGet, lsSet } from '../../lib/storage';

const KEY = 'mantle-recent-emojis';
const MAX = 32;

function load(): string[] {
  try {
    const parsed: unknown = JSON.parse(lsGet(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

export const recents = $state({ list: load() });

export function addRecent(emoji: string): void {
  recents.list = [emoji, ...recents.list.filter((e) => e !== emoji)].slice(0, MAX);
  lsSet(KEY, JSON.stringify(recents.list));
}
