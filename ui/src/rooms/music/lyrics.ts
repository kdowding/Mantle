// Lyrics model — pure derivation from saved whisper segments (works on
// existing transcripts, no re-transcribe): junk filter → lines (with word
// timing) → stanzas → type labels. Silence between phrases = structure;
// repetition = the chorus/verse signal. Port of ui/music.js's lyric block.

export interface LyricWord {
  text: string;
  start: number;
  end: number;
}

export interface LyricLine {
  text: string;
  norm: string;
  words: LyricWord[];
  start?: number;
  end?: number;
}

export interface LyricStanza {
  lines: LyricLine[];
  type: 'verse' | 'chorus' | 'hook';
  label: string;
}

export interface LyricsModel {
  stanzas: LyricStanza[];
  fallbackText: string;
}

// Raw shape of a saved <stem>.lyrics.json (whisper transcript).
export interface LyricsData {
  text?: string;
  language?: string;
  audioDurationS?: number;
  segments?: Array<{
    text?: string;
    start?: number;
    end?: number;
    words?: Array<{ word?: string; start?: number; end?: number }>;
  }>;
}

// Section-break gap. The transcript's gaps are bimodal — flowing lines sit
// near 0, real breaks land ~1.9s+ — so a fixed cut in the valley (1.6s)
// separates them. A relative/median threshold doesn't help: Whisper packs
// sung phrases into back-to-back zero-gap segments (median gap = 0), and a
// bridge's internal pauses are the same size as section breaks, so no single
// threshold cleanly splits those anyway.
const GAP_BREAK_S = 1.6;

const JUNK = new Set([
  'well be right back', 'thanks for watching', 'thank you for watching',
  'thanks for watching this video', 'please subscribe', 'subscribe',
  'like and subscribe', 'see you next time', 'see you in the next video',
  'dont forget to subscribe', 'music', 'intro', 'outro',
]);

function normLyric(s: string): string {
  return String(s || '').toLowerCase()
    .replace(/['’]/g, '') // drop apostrophes so "we'll" → "well", "don't" → "dont"
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function isJunkLine(text: string): boolean {
  const n = normLyric(text);
  return !n || JUNK.has(n); // pure punctuation / music notes, or a known Whisper hallucination
}

export function buildLyricsModel(data: LyricsData): LyricsModel {
  const segs = Array.isArray(data.segments) ? data.segments : [];
  const lines: LyricLine[] = [];
  for (const seg of segs) {
    if (isJunkLine(seg.text ?? '')) continue;
    const text = (seg.text ?? '').trim();
    if (!text) continue;
    const words: LyricWord[] = (Array.isArray(seg.words) ? seg.words : [])
      .filter((w) => typeof w.start === 'number' && typeof w.end === 'number')
      .map((w) => ({ text: w.word ?? '', start: w.start!, end: w.end! }));
    lines.push({ text, norm: normLyric(text), words, start: seg.start, end: seg.end });
  }
  // group lines into stanzas on instrumental gaps
  const stanzas: LyricStanza[] = [];
  let cur: LyricStanza | null = null;
  let prevEnd: number | null = null;
  for (const ln of lines) {
    const gap = cur && prevEnd !== null && typeof ln.start === 'number' && ln.start - prevEnd >= GAP_BREAK_S;
    if (!cur || gap) {
      cur = { lines: [], type: 'verse', label: '' };
      stanzas.push(cur);
    }
    cur.lines.push(ln);
    if (typeof ln.end === 'number') prevEnd = ln.end;
  }
  labelStanzas(stanzas, lines);
  return { stanzas, fallbackText: (data.text ?? '').trim() };
}

// Repetition is the chorus signal. Label by LINE-level repetition (robust to
// the chorus mutating and to gap fragmentation, unlike stanza-set similarity).
// The single most-recurring line is the chorus anchor; another line that
// recurs strongly marks a hook; everything else is a verse. Conservative —
// if nothing recurs ≥3×, we don't claim a chorus rather than guess.
const REFRAIN_MIN = 3;

function labelStanzas(stanzas: LyricStanza[], lines: LyricLine[]): void {
  const count = new Map<string, number>();
  for (const ln of lines) if (ln.norm) count.set(ln.norm, (count.get(ln.norm) ?? 0) + 1);
  let anchor = '';
  let anchorN = 0;
  for (const [norm, n] of count) if (n > anchorN) { anchor = norm; anchorN = n; }
  const hasChorus = anchorN >= REFRAIN_MIN;
  const isHookLine = (norm: string): boolean => norm !== anchor && (count.get(norm) ?? 0) >= REFRAIN_MIN;

  let verseNum = 0;
  for (const st of stanzas) {
    const norms = st.lines.map((l) => l.norm);
    if (hasChorus && norms.includes(anchor)) { st.type = 'chorus'; st.label = 'Chorus'; }
    else if (norms.some(isHookLine)) { st.type = 'hook'; st.label = 'Hook'; }
    else { st.type = 'verse'; st.label = `Verse ${++verseNum}`; }
  }
}
