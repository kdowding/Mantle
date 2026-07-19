<!-- Prompt panel — the generation recipe (style prompt + params) saved beside
     generated tracks, mirroring the lyrics panel's framing. The style prompt
     is copyable (the whole point is riffing on it); lineage rows walk the
     "based on" / "variations" family tree via clickable chips. -->
<script lang="ts">
  import { music, agentName, childrenOf, jumpToTrack, fmtTime, showError } from './music.svelte';
  import { ICON } from './icons';

  const panel = $derived(music.promptPanel!);
  const meta = $derived(panel.meta);
  const metaBits = $derived(
    [
      meta.model,
      meta.instrumental ? 'instrumental' : 'vocal',
      meta.durationSec ? fmtTime(meta.durationSec) : '',
      meta.generatedAt ? new Date(meta.generatedAt).toISOString().slice(0, 10) : '',
    ].filter(Boolean).join(' · '),
  );
  const kids = $derived(childrenOf(panel.song));

  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  function copyStyle(): void {
    if (!navigator.clipboard) { showError('Clipboard unavailable'); return; }
    navigator.clipboard.writeText(meta.style ?? '').then(
      () => {
        copied = true;
        if (copyTimer) clearTimeout(copyTimer);
        copyTimer = setTimeout(() => { copied = false; }, 1200);
      },
      () => showError('Copy failed'),
    );
  }
</script>

<div class="music-prompt">
  <div class="music-pr-head">
    <span class="music-pr-title">{panel.song.title}</span>
    <button class="music-pr-close" type="button" title="Close" onclick={() => (music.promptPanel = null)}>{@html ICON.close}</button>
  </div>
  <div class="music-pr-meta">{metaBits}</div>
  {#if meta.parentTitle || kids.length}
    <div class="music-pr-lineage">
      {#if meta.parentTitle}
        {@const pAid = meta.parentAgentId ?? panel.song.agentId}
        <div class="music-pr-line-row">
          <span class="music-pr-line-label">based on</span>
          <button class="music-pr-chip" type="button" title="{meta.parentTitle} - {agentName(pAid)}" onclick={() => jumpToTrack(pAid, meta.parentTitle!)}>{meta.parentTitle}</button>
        </div>
      {/if}
      {#if kids.length}
        <div class="music-pr-line-row">
          <span class="music-pr-line-label">variations · {kids.length}</span>
          <div class="music-pr-chips">
            {#each kids as k (k.agentId + k.filename)}
              <button class="music-pr-chip" type="button" title="{k.title} - {agentName(k.agentId)}" onclick={() => jumpToTrack(k.agentId, k.title)}>{k.title}</button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}
  <div class="music-pr-body">
    <div class="music-pr-section">
      <div class="music-pr-section-head">
        <div class="music-pr-label">Style prompt</div>
        {#if meta.style}
          <button class="music-pr-copy" type="button" onclick={copyStyle}>{copied ? 'copied' : 'copy'}</button>
        {/if}
      </div>
      <div class="music-pr-text">{meta.style || '(none recorded)'}</div>
    </div>
    {#if meta.tags}
      <div class="music-pr-section">
        <div class="music-pr-section-head"><div class="music-pr-label">Suno tags</div></div>
        <div class="music-pr-text">{meta.tags}</div>
      </div>
    {/if}
    {#if !meta.instrumental && meta.lyrics}
      <div class="music-pr-section">
        <div class="music-pr-section-head"><div class="music-pr-label">Lyrics</div></div>
        <div class="music-pr-text">{meta.lyrics}</div>
      </div>
    {/if}
  </div>
</div>

<style>
  /* The body is mono so the prompt reads like the recipe it is. */
  .music-prompt {
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-tertiary);
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: 46%;
    overflow-y: auto;
  }
  .music-pr-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .music-pr-title {
    flex: 1;
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 13px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .music-pr-close {
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
  .music-pr-close:hover { color: var(--accent-pink); border-color: var(--accent-pink); }
  .music-pr-meta {
    font-family: var(--font-mono);
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent);
  }
  .music-pr-body { display: flex; flex-direction: column; gap: 11px; }
  .music-pr-section { display: flex; flex-direction: column; gap: 4px; }
  .music-pr-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .music-pr-label {
    font-family: var(--font-mono);
    font-size: 8.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .music-pr-copy {
    font-family: var(--font-mono);
    font-size: 8.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 2px 7px;
    cursor: pointer;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid var(--border);
    clip-path: polygon(3px 0, 100% 0, 100% calc(100% - 3px), calc(100% - 3px) 100%, 0 100%, 0 3px);
    transition: color 0.12s, border-color 0.12s, box-shadow 0.12s;
  }
  .music-pr-copy:hover { color: var(--accent); border-color: var(--accent-edge); box-shadow: 0 0 8px var(--accent-dim); }
  .music-pr-text {
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    padding: 7px 9px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    clip-path: polygon(5px 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%, 0 5px);
  }

  /* Lineage: "based on" + "variations" rows of clickable chips that jump the
     panel along the family tree. */
  .music-pr-lineage { display: flex; flex-direction: column; gap: 6px; }
  .music-pr-line-row { display: flex; align-items: baseline; gap: 8px; }
  .music-pr-line-label {
    flex-shrink: 0;
    padding-top: 3px;
    font-family: var(--font-mono);
    font-size: 8.5px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .music-pr-chips { display: flex; flex-wrap: wrap; gap: 5px; min-width: 0; }
  .music-pr-chip {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-sans);
    font-size: 11px;
    cursor: pointer;
    padding: 2px 8px;
    color: var(--accent);
    background: var(--accent-faint);
    border: 1px solid var(--accent-edge);
    clip-path: polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px);
    transition: background 0.12s, box-shadow 0.12s;
  }
  .music-pr-chip:hover { background: var(--accent-dim); box-shadow: 0 0 8px var(--accent-dim); }
</style>
