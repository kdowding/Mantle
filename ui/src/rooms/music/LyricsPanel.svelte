<!-- Karaoke lyrics review — stanzas labeled Verse/Chorus/Hook from the saved
     whisper segments. When the panel shows the currently-playing track, an
     rAF loop drives the synced highlight off audio.currentTime: past lines
     dim, the current line brightens with a per-word fill, and the view
     auto-scrolls to keep the current line centered. -->
<script lang="ts">
  import { music, sameSong, getAudioTime } from './music.svelte';
  import { buildLyricsModel } from './lyrics';
  import { ICON } from './icons';

  const panel = $derived(music.lyricsPanel!);
  const model = $derived(buildLyricsModel(panel.data));
  const lang = $derived(panel.data.language ? String(panel.data.language).toUpperCase() : '?');
  const dur = $derived(panel.data.audioDurationS ? `${Math.round(panel.data.audioDurationS)}s` : '');

  // Flat line list in render order (stanzas are a display grouping).
  const flatLines = $derived(model.stanzas.flatMap((st) => st.lines));
  const offsets = $derived.by(() => {
    let n = 0;
    return model.stanzas.map((st) => { const o = n; n += st.lines.length; return o; });
  });

  // Sync only while this panel shows the playing track.
  const synced = $derived(!!music.current && sameSong(panel.song, music.current));

  let activeLine = $state(-1);
  // Word fill within the active line: indexes ≤ sung are sung; `active` is the
  // word currently spanning the playhead (or -1).
  let wordCut = $state({ sung: -1, active: -1 });

  let rootEl: HTMLDivElement;
  let lineEls: HTMLElement[] = $state([]);

  function scrollToLine(el: HTMLElement): void {
    const lr = el.getBoundingClientRect();
    const cr = rootEl.getBoundingClientRect();
    const delta = (lr.top - cr.top) - rootEl.clientHeight / 2 + lr.height / 2;
    rootEl.scrollBy({ top: delta, behavior: 'smooth' });
  }

  $effect(() => {
    const lines = flatLines;
    if (!synced || !lines.length) {
      activeLine = -1;
      wordCut = { sung: -1, active: -1 };
      return;
    }
    let raf = 0;
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const t = getAudioTime();
      let idx = -1;
      for (let i = 0; i < lines.length; i++) {
        const s = lines[i].start;
        if (typeof s === 'number' && s <= t) idx = i;
        else if (typeof s === 'number' && s > t) break;
      }
      if (idx !== activeLine) {
        activeLine = idx;
        wordCut = { sung: -1, active: -1 };
        const el = lineEls[idx];
        if (idx >= 0 && el) scrollToLine(el);
      }
      if (idx >= 0) {
        const words = lines[idx].words;
        let sung = -1, active = -1;
        for (let i = 0; i < words.length; i++) {
          if (t >= words[i].end) sung = i;
          else if (t >= words[i].start) active = i;
        }
        if (sung !== wordCut.sung || active !== wordCut.active) wordCut = { sung, active };
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
</script>

<div class="music-lyrics" bind:this={rootEl}>
  <div class="music-ly-head">
    <span class="music-ly-title">{panel.song.title}</span>
    <button class="music-ly-close" type="button" title="Close" onclick={() => (music.lyricsPanel = null)}>{@html ICON.close}</button>
  </div>
  <div class="music-ly-meta">whisper · {lang}{dur ? ` · ${dur}` : ''}</div>
  <div class="music-ly-body">
    {#if !model.stanzas.length}
      <div class="music-ly-empty">{model.fallbackText || '(no lyrics detected - likely instrumental)'}</div>
    {:else}
      {#each model.stanzas as st, si (si)}
        <div class="music-ly-stanza music-ly-{st.type}">
          <div class="music-ly-tag">{st.label}</div>
          {#each st.lines as ln, li (li)}
            {@const gi = offsets[si] + li}
            <div
              class="music-ly-line"
              class:is-past={activeLine >= 0 && gi < activeLine}
              class:is-current={gi === activeLine}
              class:is-future={activeLine >= 0 && gi > activeLine}
              bind:this={lineEls[gi]}
            >
              {#if ln.words.length}
                {#each ln.words as w, wi (wi)}
                  <span
                    class="music-ly-word"
                    class:is-sung={gi === activeLine && wi <= wordCut.sung}
                    class:is-active={gi === activeLine && wi === wordCut.active}
                  >{w.text}</span>
                {/each}
              {:else}
                {ln.text}
              {/if}
            </div>
          {/each}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .music-lyrics {
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-tertiary);
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 42%;
    overflow-y: auto;
  }
  .music-ly-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .music-ly-title {
    flex: 1;
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 13px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .music-ly-close {
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    flex-shrink: 0;
    line-height: 1;
    font-size: 15px;
    cursor: pointer;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid var(--border);
    clip-path: polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px);
    transition: color 0.15s, border-color 0.15s;
  }
  .music-ly-close:hover { color: var(--accent-pink); border-color: var(--accent-pink); }
  .music-ly-meta {
    font-family: var(--font-mono);
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent);
  }
  .music-ly-body { display: flex; flex-direction: column; gap: 13px; }
  .music-ly-stanza { display: flex; flex-direction: column; gap: 1px; }
  .music-ly-tag {
    font-family: var(--font-mono);
    font-size: 8.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 3px;
  }
  .music-ly-chorus > .music-ly-tag { color: var(--accent); }
  .music-ly-hook > .music-ly-tag { color: var(--accent-purple); }
  .music-ly-line {
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--text-secondary);
    word-break: break-word;
    transition: opacity 0.25s, color 0.25s;
  }
  .music-ly-word { transition: color 0.12s, text-shadow 0.12s; }
  /* synced karaoke states — driven by the rAF loop while the playing track is shown */
  .music-ly-line.is-past { opacity: 0.4; }
  .music-ly-line.is-future { opacity: 0.62; }
  .music-ly-line.is-current { color: var(--text-primary); }
  .music-ly-line.is-current .music-ly-word.is-sung { color: var(--accent); }
  .music-ly-line.is-current .music-ly-word.is-active { color: var(--accent); text-shadow: 0 0 9px var(--accent-glow); }
  .music-ly-empty { color: var(--text-muted); font-style: italic; }
</style>
