// Line diff → reviewable hunks. Pure, dependency-free — the engine behind both
// the dock's other-file diffs and the in-editor InlineDiff (components/). Lives
// in lib/ so the systems decks can render Cursor-style diffs without importing
// from the assist ROOM (the decks already couple to the room for setAssistTarget;
// the diff ALGORITHM has no business crossing that seam). Re-exported from
// rooms/assist/assist.svelte for the dock's existing import sites.
//
// Artifacts are small (≤ a few hundred lines); the LCS is O(n·m) and fine.

interface RawRow {
  type: 'same' | 'add' | 'del';
  text: string;
}

export interface DiffHunk {
  kind: 'hunk';
  id: number;
  dels: string[];
  adds: string[];
}
export interface DiffContext {
  kind: 'context';
  lines: string[];
}
export type DiffSegment = DiffHunk | DiffContext;

// The raw LCS line diff (no collapsing) underpins both the segment view and the
// per-hunk reconstruction.
function rawLineDiff(oldText: string, newText: string): RawRow[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const raw: RawRow[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { raw.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { raw.push({ type: 'del', text: a[i] }); i++; }
    else { raw.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) raw.push({ type: 'del', text: a[i++] });
  while (j < m) raw.push({ type: 'add', text: b[j++] });
  return raw;
}

// Group the raw diff into context blocks + change HUNKS (a maximal run of
// add/del). Each hunk is independently acceptable; ids index the hunk mask.
export function segmentDiff(oldText: string, newText: string): { segments: DiffSegment[]; hunkCount: number } {
  const raw = rawLineDiff(oldText, newText);
  const segments: DiffSegment[] = [];
  let hunkId = 0;
  let i = 0;
  while (i < raw.length) {
    if (raw[i].type === 'same') {
      const lines: string[] = [];
      while (i < raw.length && raw[i].type === 'same') { lines.push(raw[i].text); i++; }
      segments.push({ kind: 'context', lines });
    } else {
      const dels: string[] = [], adds: string[] = [];
      while (i < raw.length && raw[i].type !== 'same') {
        (raw[i].type === 'del' ? dels : adds).push(raw[i].text);
        i++;
      }
      segments.push({ kind: 'hunk', id: hunkId++, dels, adds });
    }
  }
  return { segments, hunkCount: hunkId };
}

// Rebuild file content from a per-hunk accept mask: context always kept; a hunk
// contributes its ADDED lines if accepted, else its ORIGINAL (deleted) lines.
export function reconstructContent(segments: DiffSegment[], accepted: boolean[]): string {
  const lines: string[] = [];
  for (const seg of segments) {
    if (seg.kind === 'context') lines.push(...seg.lines);
    else lines.push(...(accepted[seg.id] ? seg.adds : seg.dels));
  }
  return lines.join('\n');
}

// Collapse a long unchanged run for display (±3 context near the surrounding
// hunks; the file edges drop their outer context). Returns display rows; a
// `gap` row stands in for the hidden lines.
const CTX = 3;
export function collapseContext(
  lines: string[],
  isFirst: boolean,
  isLast: boolean,
): Array<{ text: string; gap?: boolean }> {
  if (lines.length <= CTX * 2 + 1) return lines.map((text) => ({ text }));
  const top = isFirst ? [] : lines.slice(0, CTX);
  const bottom = isLast ? [] : lines.slice(-CTX);
  const hidden = lines.length - top.length - bottom.length;
  const out: Array<{ text: string; gap?: boolean }> = top.map((text) => ({ text }));
  if (hidden > 0) out.push({ text: `⋯ ${hidden} unchanged line${hidden === 1 ? '' : 's'}`, gap: true });
  out.push(...bottom.map((text) => ({ text })));
  return out;
}
