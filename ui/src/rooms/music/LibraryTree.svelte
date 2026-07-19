<!-- Library tree — agent buckets ("drives", default open) holding root tracks,
     nested folders, and in-flight generation rows. Owns ALL the tree styling
     (:global under .music-library) so FolderRow / TrackRow / the inline-edit
     bits stay style-less. -->
<script lang="ts">
  import {
    music, agentName, agentAccent, filterList, searchQuery,
    isExpanded, setExpanded, bucketKey, triggerUpload, createFolder, moveTrack,
  } from './music.svelte';
  import { ICON, SVG } from './icons';
  import InlineInput from './InlineInput.svelte';
  import TrackRow from './TrackRow.svelte';
  import FolderRow from './FolderRow.svelte';

  const buckets = $derived(
    Object.keys(music.library).sort((a, b) => agentName(a).localeCompare(agentName(b))),
  );
  const totalTracks = $derived(buckets.reduce((n, b) => n + (music.library[b]?.length ?? 0), 0));

  // One transient "new folder" row + one droptarget across all bucket heads.
  let creatingBucket = $state<string | null>(null);
  let dropBucket = $state<string | null>(null);

  function onBucketDragOver(e: DragEvent, aid: string): void {
    if (music.dragged && music.dragged.agentId === aid) {
      e.preventDefault();
      dropBucket = aid;
    }
  }

  // bucket root is a drop target (move to root)
  function onBucketDrop(e: DragEvent, aid: string): void {
    dropBucket = null;
    const d = music.dragged;
    if (!d || d.agentId !== aid) return;
    e.preventDefault();
    const curFolder = d.filename.includes('/') ? d.filename.slice(0, d.filename.lastIndexOf('/')) : '';
    if (curFolder === '') return;
    void moveTrack(aid, d.filename, '');
  }
</script>

<div class="music-library">
  {#if !music.loaded}
    <div class="music-empty">Loading…</div>
  {:else if totalTracks === 0 && music.generating.length === 0}
    <div class="music-empty">
      {#if music.canGenerate}
        No tracks yet. Hit <b>Generate</b> - or ask an agent to make one.
      {:else}
        No tracks yet.
      {/if}
    </div>
  {:else}
    {#each buckets as aid (aid)}
      {@const songs = filterList(music.library[aid] ?? [])}
      {@const genForBucket = music.generating.filter((g) => g.agentId === aid)}
      {#if !(songs.length === 0 && genForBucket.length === 0 && searchQuery())}
        {@const bKey = bucketKey(aid)}
        {@const open = isExpanded(bKey, true)}
        <div class="music-bucket">
          <div
            class="music-bucket-head"
            class:is-droptarget={dropBucket === aid}
            role="button"
            tabindex="0"
            onclick={() => setExpanded(bKey, !open, true)}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(bKey, !open, true); } }}
            ondragover={(e) => onBucketDragOver(e, aid)}
            ondragleave={() => { if (dropBucket === aid) dropBucket = null; }}
            ondrop={(e) => onBucketDrop(e, aid)}
          >
            <span class="music-caret">{@html open ? ICON.folderOpen : ICON.folder}</span>
            <span class="music-bucket-dot" style:background={agentAccent(aid) || null}></span>
            <span class="music-bucket-name">{agentName(aid)}</span>
            <span class="music-bucket-count">{music.library[aid]?.length ?? 0}</span>
            <button class="music-mini" type="button" title="Upload mp3" onclick={(e) => { e.stopPropagation(); triggerUpload(aid, ''); }}>{@html SVG.upload}</button>
            <button class="music-mini" type="button" title="New folder" onclick={(e) => { e.stopPropagation(); creatingBucket = aid; }}>{@html ICON.plus}</button>
          </div>
          {#if creatingBucket === aid}
            <div class="music-create-row">
              <InlineInput
                placeholder="New folder name…"
                oncommit={(v) => { creatingBucket = null; void createFolder(aid, '', v); }}
                oncancel={() => (creatingBucket = null)}
              />
            </div>
          {/if}
          {#if open}
            <div class="music-bucket-body">
              <!-- root-level tracks (folder === "") -->
              {#each songs.filter((x) => !x.folder) as s (s.filename)}
                <TrackRow song={s} />
              {/each}
              <!-- nested folders -->
              {#each music.folderHierarchy[aid]?.children ?? [] as child (child.path)}
                <FolderRow {aid} node={child} {songs} />
              {/each}
              <!-- in-flight generations -->
              {#each genForBucket as g (g.taskId ?? g.title)}
                <div class="music-generating"><span class="music-spin"></span> generating “{g.title}”…</div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {/each}
  {/if}
</div>

<style>
  .music-library { flex: 1; overflow-y: auto; padding: 2px 8px 18px; }
  .music-empty { padding: 28px 16px; text-align: center; color: var(--text-muted); font-size: 13px; line-height: 1.55; }

  /* Agent bucket = a "drive" header */
  .music-library :global(.music-bucket) { margin-bottom: 7px; }
  .music-library :global(.music-bucket-head) {
    display: flex; align-items: center; gap: 7px; padding: 7px 9px; cursor: pointer;
    font-family: var(--font-display); font-size: 12px; font-weight: 600;
    letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-secondary);
    background: var(--bg-tertiary); border: 1px solid var(--border);
    clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px));
    transition: color 0.15s, border-color 0.15s, background 0.15s, box-shadow 0.15s;
  }
  .music-library :global(.music-bucket-head:hover) { color: var(--text-primary); border-color: var(--accent-edge); }
  .music-library :global(.music-bucket-head.is-droptarget) { border-color: var(--accent); background: var(--accent-dim); box-shadow: inset 0 0 14px var(--accent-dim); }
  .music-library :global(.music-bucket-dot) {
    width: 9px; height: 9px; background: var(--accent); flex-shrink: 0; box-shadow: 0 0 6px var(--accent-glow);
    clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
  }
  .music-library :global(.music-bucket-name) { flex: 1; }
  .music-library :global(.music-bucket-count),
  .music-library :global(.music-folder-count) {
    font-family: var(--font-mono); font-size: 9.5px; color: var(--accent);
    padding: 1px 6px; background: var(--bg-primary); border: 1px solid var(--border);
  }

  /* Tree bodies — vertical guide lines sell the folder look */
  .music-library :global(.music-bucket-body) { padding: 3px 0 2px; }
  .music-library :global(.music-folder-body) { margin-left: 14px; padding-left: 7px; border-left: 1px solid var(--border); }

  .music-library :global(.music-folder-head) {
    display: flex; align-items: center; gap: 6px; padding: 5px 8px; cursor: pointer;
    font-family: var(--font-sans); font-size: 12px; color: var(--text-muted);
    border: 1px solid transparent;
  }
  .music-library :global(.music-folder-head:hover) { background: var(--accent-faint); color: var(--text-primary); }
  .music-library :global(.music-folder-head.is-droptarget) { border-color: var(--accent); background: var(--accent-dim); }
  .music-library :global(.music-caret) { font-size: 8px; color: var(--text-muted); width: 10px; text-align: center; flex-shrink: 0; }
  .music-library :global(.music-folder-icon),
  .music-library :global(.music-track-icon) { display: grid; place-items: center; width: 15px; flex-shrink: 0; }
  .music-library :global(.music-folder-icon) { color: var(--accent); opacity: 0.85; }
  .music-library :global(.music-folder-icon svg),
  .music-library :global(.music-track-icon svg) { width: 14px; height: 14px; display: block; }
  .music-library :global(.music-folder-name) { flex: 1; }

  /* mini action buttons (hover-revealed on tracks, always-on for heads) */
  .music-library :global(.music-mini) {
    width: 20px; height: 20px; display: grid; place-items: center; flex-shrink: 0;
    font-size: 11px; line-height: 1; cursor: pointer; text-decoration: none;
    color: var(--text-muted); background: transparent; border: 1px solid transparent;
    transition: color 0.12s, border-color 0.12s;
  }
  .music-library :global(.music-mini:hover) { color: var(--accent); border-color: var(--border-strong); }
  .music-library :global(.music-mini svg) { width: 13px; height: 13px; display: block; }
  .music-library :global(.music-track-del:hover) { color: var(--accent-pink); border-color: var(--accent-pink); }
  /* armed (about-to-delete) trash button */
  .music-library :global(.music-mini.is-armed) {
    color: var(--bg-primary); background: var(--accent-pink); border-color: var(--accent-pink);
    box-shadow: 0 0 8px rgba(255, 45, 124, 0.4); opacity: 1;
  }

  /* Track = a file row */
  .music-library :global(.music-track) {
    position: relative;
    display: flex; align-items: center; gap: 7px; padding: 5px 8px; cursor: pointer;
    font-size: 12.5px; color: var(--text-secondary); border: 1px solid transparent;
  }
  .music-library :global(.music-track:hover) { background: var(--accent-faint); color: var(--text-primary); }
  .music-library :global(.music-track.is-active) { background: var(--accent-dim); color: var(--accent); border-color: var(--accent-edge); }
  .music-library :global(.music-track.is-active::before) {
    content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
    background: var(--accent); box-shadow: 0 0 8px var(--accent-glow);
  }
  .music-library :global(.music-track.is-dragging) { opacity: 0.4; }
  .music-library :global(.music-track-icon) { color: var(--text-muted); }
  .music-library :global(.music-track.is-active .music-track-icon) { color: var(--accent); }
  /* album-art thumbnail in place of the EQ glyph when a track has a cover */
  .music-library :global(.music-track-thumb) {
    width: 18px; height: 18px; object-fit: cover; flex-shrink: 0; display: block;
    border: 1px solid var(--border-strong);
    clip-path: polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px);
  }
  .music-library :global(.music-track.is-active .music-track-thumb) { border-color: var(--accent-edge); box-shadow: 0 0 6px var(--accent-dim); }
  .music-library :global(.music-track-title) { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .music-library :global(.music-track .music-mini) { opacity: 0; }
  .music-library :global(.music-track:hover .music-mini),
  .music-library :global(.music-track.is-active .music-mini) { opacity: 1; }
  /* karaoke / prompt buttons light up on tracks that have the sidecar */
  .music-library :global(.music-track.has-lyrics .music-track-cc) { opacity: 1; color: var(--accent); }
  .music-library :global(.music-track.has-prompt .music-track-prompt) { opacity: 1; color: var(--accent); }
  .music-library :global(.music-track-cc .music-spin) { width: 11px; height: 11px; }

  /* Inline editing (replaces browser prompt/confirm/alert) */
  .music-library :global(.music-inline-input) {
    flex: 1; min-width: 0; padding: 2px 7px;
    font-family: var(--font-sans); font-size: 12px; color: var(--text-primary);
    background: var(--bg-input); border: 1px solid var(--accent-edge); outline: none;
  }
  .music-library :global(.music-inline-input:focus) { border-color: var(--accent); box-shadow: 0 0 8px var(--accent-dim); }
  .music-library :global(.music-create-row) { display: flex; align-items: center; padding: 4px 8px 4px 18px; }

  .music-library :global(.music-generating) {
    display: flex; align-items: center; gap: 8px; padding: 6px 8px;
    font-size: 12px; font-style: italic; color: var(--text-muted);
  }
  .music-library :global(.music-spin) {
    width: 11px; height: 11px; flex-shrink: 0;
    border: 2px solid var(--border-strong); border-top-color: var(--accent);
    border-radius: 50%; animation: music-spin 0.8s linear infinite;
  }
  @keyframes -global-music-spin { to { transform: rotate(360deg); } }

  @media (prefers-reduced-motion: reduce) {
    .music-library :global(.music-spin) { animation: none; }
  }
</style>
