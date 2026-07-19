// Last-seen tracking (ls-backed, best-effort) — powers the sidebar unread
// dots and the "new since you left" divider. Two lenses per session:
//  - seen COUNT: the server meta's messageCount at last view (badge compare)
//  - seen BUILT: chat.messages.length at last view (divider position — same
//    builder both times, so the index is meaningful)
// A session never visited from this browser reads null → never badged
// (avoids lighting up the whole history on first run).
import { lsGet, lsSet } from './storage';
import type { SessionMeta } from './api';

const countKey = (sid: string): string => `mantle-seen-count:${sid}`;
const builtKey = (sid: string): string => `mantle-seen-built:${sid}`;

export function seenCount(sid: string): number | null {
  const v = lsGet(countKey(sid));
  return v == null ? null : Number(v) || 0;
}
export function markSeenCount(sid: string, count: number | undefined): void {
  if (typeof count === 'number') lsSet(countKey(sid), String(count));
}

export function seenBuilt(sid: string): number | null {
  const v = lsGet(builtKey(sid));
  return v == null ? null : Number(v) || 0;
}
export function markSeenBuilt(sid: string, len: number): void {
  lsSet(builtKey(sid), String(len));
}

export function isUnread(s: SessionMeta): boolean {
  const seen = seenCount(s.id);
  return seen != null && (s.messageCount ?? 0) > seen;
}
