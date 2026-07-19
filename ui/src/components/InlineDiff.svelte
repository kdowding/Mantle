<script lang="ts">
  // Cursor-style inline diff, rendered INSIDE the systems-deck editor (not the
  // assist dock). Shows baseline → proposed as a git diff with per-hunk
  // accept/reject (✓ keep the change / ✕ keep the original), plus accept-all /
  // reject-all. The file resolves the instant every hunk has a verdict (or a
  // bulk action), at which point onResolve(content) fires once. Pure +
  // presentational: it owns the per-hunk DECISIONS and reconstructs the final
  // content, but the PARENT does the actual write (set its buffer / run
  // applySpec) — so a write/parse error surfaces here via `applyError`, not the
  // dock. Props in, callbacks out (no $bindable).
  import { segmentDiff, reconstructContent, collapseContext } from '../lib/diff';

  type HunkDecision = 'undecided' | 'accepted' | 'rejected';

  let {
    baseline,
    proposed,
    fileLabel = '',
    kindLabel = 'edit',
    note,
    stale = false,
    applyError = null,
    onResolve,
    onDiscard,
  }: {
    baseline: string;
    proposed: string;
    fileLabel?: string;
    kindLabel?: string;
    note?: string;
    stale?: boolean;
    applyError?: string | null;
    onResolve: (content: string) => void;
    onDiscard: () => void;
  } = $props();

  // Diff + reconstruct on LF-normalized text. The editor buffer is LF (a
  // <textarea> reports LF), but an on-disk CRLF file or an agent that echoes
  // CRLF would otherwise make every line differ (noisy diff) and write CRLF
  // back to disk (a permanent false-dirty). LF in, LF out — the one chokepoint.
  const baseLF = $derived(baseline.replace(/\r\n/g, '\n'));
  const propLF = $derived(proposed.replace(/\r\n/g, '\n'));
  const sd = $derived(segmentDiff(baseLF, propLF));
  let decisions = $state<HunkDecision[]>([]);

  // Re-seed to all-undecided whenever the diff identity changes (a fresh
  // proposal replaces the open file). Reads sd only; writes decisions only — no
  // self-trigger. Never fire onResolve from here (re-entrancy trap) — only from
  // click handlers.
  $effect(() => {
    const n = sd.hunkCount;
    decisions = Array.from({ length: n }, () => 'undecided' as HunkDecision);
  });

  const adds = $derived(sd.segments.reduce((s, g) => s + (g.kind === 'hunk' ? g.adds.length : 0), 0));
  const dels = $derived(sd.segments.reduce((s, g) => s + (g.kind === 'hunk' ? g.dels.length : 0), 0));
  // Derive counts against sd.hunkCount (not decisions.length) so they're correct
  // on the first frame too — decisions starts [] until the re-seed effect runs.
  const decided = $derived(decisions.filter((d) => d !== 'undecided').length);
  const remaining = $derived(sd.hunkCount - decided);
  const allDecided = $derived(sd.hunkCount > 0 && decided === sd.hunkCount);

  // The content if we committed the current verdicts: accepted hunk ⇒ its added
  // lines, rejected/undecided ⇒ the original lines. Only consumed at resolve
  // time (when nothing is undecided), so undecided-as-original is moot.
  function currentContent(): string {
    return reconstructContent(sd.segments, decisions.map((d) => d === 'accepted'));
  }

  function resolve(): void {
    const c = currentContent();
    // Every hunk rejected (or an empty diff) ⇒ no write — just clear it.
    // Compare against the normalized baseline (c is LF-reconstructed).
    if (c === baseLF) onDiscard();
    else onResolve(c);
  }

  function decide(id: number, d: HunkDecision): void {
    decisions[id] = d;
    if (decisions.every((x) => x !== 'undecided')) resolve();
  }
  function reopen(id: number): void {
    decisions[id] = 'undecided';
  }
  function acceptAll(): void {
    decisions = decisions.map(() => 'accepted');
    resolve();
  }
  function rejectAll(): void {
    decisions = decisions.map(() => 'rejected');
    resolve(); // content === baseline ⇒ onDiscard
  }
</script>

<div class="idiff" class:stale>
  <div class="id-head">
    <span class="id-kind" class:new={kindLabel === 'new'}>{kindLabel}</span>
    <span class="id-file" title={fileLabel}>{fileLabel}</span>
    <span class="id-stats"><span class="plus">+{adds}</span> <span class="minus">−{dels}</span></span>
  </div>
  {#if note}<div class="id-note">{note}</div>{/if}

  {#if sd.hunkCount === 0}
    <div class="id-empty">No changes to review - the proposal matches the current content.</div>
    <div class="id-foot">      <button class="id-bulk reject" type="button" onclick={onDiscard}>dismiss</button>
    </div>
  {:else}
    <div class="id-hint">
      {decided}/{sd.hunkCount} block{sd.hunkCount === 1 ? '' : 's'} decided -
      ✓ keep the change · ✕ keep the original, or the buttons below
    </div>
    <div class="id-diff">
      {#each sd.segments as seg, si (si)}
        {#if seg.kind === 'context'}
          {#each collapseContext(seg.lines, si === 0, si === sd.segments.length - 1) as row, ri (ri)}
            <div class="dr {row.gap ? 'gap' : 'same'}">{row.text || ' '}</div>
          {/each}
        {:else}
          {@const d = decisions[seg.id] ?? 'undecided'}
          <div class="hunk {d}">
            <div class="hunk-gut">
              {#if d === 'undecided'}
                <button class="gut-btn acc" type="button" title="Keep the change" onclick={() => decide(seg.id, 'accepted')}>✓</button>
                <button class="gut-btn rej" type="button" title="Keep the original" onclick={() => decide(seg.id, 'rejected')}>✕</button>
              {:else}
                <button class="gut-btn done {d}" type="button" title="Undo - review this block again" onclick={() => reopen(seg.id)}>
                  {d === 'accepted' ? '✓' : '✕'}
                </button>
              {/if}
            </div>
            <div class="hunk-lines">
              {#if d !== 'accepted'}
                {#each seg.dels as ln, di (di)}<div class="dr del">{ln || ' '}</div>{/each}
              {/if}
              {#if d !== 'rejected'}
                {#each seg.adds as ln, ai (ai)}<div class="dr add">{ln || ' '}</div>{/each}
              {/if}
            </div>
          </div>
        {/if}
      {/each}
    </div>

    {#if stale}
      <div class="id-stale">The editor changed since this was staged - accepting replaces your current content.</div>
    {/if}
    {#if applyError}
      <div class="id-err">{applyError}</div>
    {/if}

    <div class="id-foot">
      <span class="id-count">{allDecided ? 'all blocks decided' : `${remaining} block${remaining === 1 ? '' : 's'} left`}</span>      <button class="id-bulk reject" type="button" onclick={rejectAll}>✕ reject all</button>
      <button class="id-bulk accept" type="button" onclick={acceptAll}>✓ accept all</button>
    </div>
  {/if}
</div>

<style>
  .idiff {
    position: relative; /* anchor for the floating accept/reject pill */
    flex: 1;
    min-width: 0; /* let it shrink within its grid/flex column instead of
                     stretching to the longest (white-space:pre) diff line */
    min-height: 0;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--accent-edge);
    border-left: 2px solid var(--accent);
    background: var(--bg-secondary);
    padding-bottom: 58px; /* clear zone the floating pill sits in */
  }
  .idiff.stale { border-color: color-mix(in srgb, var(--warning) 50%, transparent); border-left-color: var(--warning); }

  .id-head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
    padding: 9px 12px;
    border-bottom: 1px solid var(--border);
  }
  .id-kind {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 9.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--accent-edge);
    color: var(--accent);
  }
  .id-kind.new { border-color: var(--warning); color: var(--warning); }
  .id-file {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .id-stats { margin-left: auto; flex-shrink: 0; font-family: var(--font-mono); font-size: 12px; }
  .plus { color: var(--success); }
  .minus { color: var(--error); }

  .id-note { padding: 8px 12px 0; font-size: 12.5px; color: var(--text-secondary); line-height: 1.45; }
  .id-hint { padding: 8px 12px 4px; font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); flex-shrink: 0; }
  .id-empty { padding: 18px 12px; color: var(--text-muted); font-size: 13px; }

  .id-diff {
    flex: 1;
    min-width: 0; /* the actual scroll boundary — long pre lines scroll here */
    min-height: 0;
    margin: 4px 12px;
    overflow: auto;
    border: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.55;
  }
  .dr { padding: 0 8px; white-space: pre; }
  .dr.same { color: var(--text-muted); }
  .dr.add { background: rgba(0, 255, 136, 0.08); color: var(--success); }
  .dr.add::before { content: '+ '; opacity: 0.7; }
  .dr.del { background: rgba(255, 45, 124, 0.08); color: var(--error); text-decoration: line-through; text-decoration-color: rgba(255, 45, 124, 0.4); }
  .dr.del::before { content: '− '; opacity: 0.7; }
  .dr.same::before { content: '  '; }
  .dr.gap {
    color: var(--text-muted);
    font-style: italic;
    text-align: center;
    border-top: 1px dashed var(--border);
    border-bottom: 1px dashed var(--border);
  }

  /* ── Per-hunk gutter + resolved states ─────────────────────────────────── */
  .hunk { display: flex; border-left: 2px solid transparent; }
  .hunk.undecided { border-left-color: var(--accent-edge); }
  .hunk.accepted { border-left-color: color-mix(in srgb, var(--success) 60%, transparent); }
  .hunk.rejected { border-left-color: var(--border-strong); }
  .hunk-gut {
    flex-shrink: 0;
    width: 26px;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
  }
  .gut-btn {
    flex: 1;
    min-height: 18px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 11px;
    cursor: pointer;
    padding: 0;
    transition: background 0.12s, color 0.12s;
  }
  .gut-btn.acc:hover { background: rgba(0, 255, 136, 0.12); color: var(--success); }
  .gut-btn.rej:hover { background: rgba(255, 45, 124, 0.12); color: var(--error); }
  .gut-btn.acc { border-bottom: 1px solid var(--border); }
  .gut-btn.done.accepted { color: var(--success); }
  .gut-btn.done.rejected { color: var(--error); }
  .gut-btn.done:hover { background: var(--bg-tertiary); }
  .hunk-lines { flex: 1; min-width: 0; }
  /* A RESOLVED hunk renders only its surviving side, as plain (non-diff) text. */
  .hunk.accepted .dr.add { background: transparent; color: var(--text-secondary); }
  .hunk.accepted .dr.add::before { content: '  '; }
  .hunk.rejected .dr.del { background: transparent; color: var(--text-secondary); text-decoration: none; }
  .hunk.rejected .dr.del::before { content: '  '; }

  .id-stale { padding: 6px 12px 0; font-size: 11.5px; color: var(--warning); line-height: 1.4; flex-shrink: 0; }
  .id-err { padding: 6px 12px 0; font-size: 11.5px; color: var(--error); line-height: 1.4; flex-shrink: 0; }

  /* Floating accept/reject pill, centered at the bottom of the content area
     (Cursor-style) — absolute to .idiff so it can't get pushed out of column. */
  .id-foot {
    position: absolute;
    left: 50%;
    bottom: 14px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 6px 12px;
    background: var(--bg-tertiary);
    border: 1px solid var(--accent-edge);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
    white-space: nowrap;
    z-index: 4;
  }
  .id-count { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); }
  .id-bulk {
    padding: 6px 14px;
    font-family: var(--font-display);
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    cursor: pointer;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
  }
  .id-bulk.accept { background: var(--accent); border: none; color: var(--bg-primary); }
  .id-bulk.accept:hover { box-shadow: 0 0 12px var(--accent-glow); }
  .id-bulk.reject { background: transparent; border: 1px solid var(--border-strong); color: var(--text-muted); }
  .id-bulk.reject:hover { color: var(--error); border-color: var(--error); }
</style>
