<!-- A folder in an agent bucket — recursive (folders nest freely). The head
     toggles expansion (folders default CLOSED, unlike buckets) and is a drop
     target for track moves within the same bucket. -->
<script lang="ts">
  import {
    music, isExpanded, setExpanded, folderKey, triggerUpload,
    createFolder, renameFolder, deleteFolder, moveTrack,
    type FolderNode, type Song,
  } from './music.svelte';
  import { ICON, SVG } from './icons';
  import InlineInput from './InlineInput.svelte';
  import ArmDelete from './ArmDelete.svelte';
  import TrackRow from './TrackRow.svelte';
  import Self from './FolderRow.svelte';

  let { aid, node, songs }: { aid: string; node: FolderNode; songs: Song[] } = $props();

  const key = $derived(folderKey(aid, node.path));
  const open = $derived(isExpanded(key, false));
  const here = $derived(songs.filter((s) => (s.folder || '') === node.path));

  let renaming = $state(false);
  let creating = $state(false);
  let droptarget = $state(false);

  function toggle(): void {
    setExpanded(key, !open, false);
  }

  function onDragOver(e: DragEvent): void {
    if (music.dragged && music.dragged.agentId === aid) {
      e.preventDefault();
      droptarget = true;
    }
  }

  function onDrop(e: DragEvent): void {
    droptarget = false;
    const d = music.dragged;
    if (!d || d.agentId !== aid) return;
    e.preventDefault();
    // no-op if already in this folder
    const curFolder = d.filename.includes('/') ? d.filename.slice(0, d.filename.lastIndexOf('/')) : '';
    if (curFolder === node.path) return;
    void moveTrack(aid, d.filename, node.path);
  }
</script>

<div class="music-folder">
  <div
    class="music-folder-head"
    class:is-droptarget={droptarget}
    role="button"
    tabindex="0"
    onclick={toggle}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
    ondragover={onDragOver}
    ondragleave={() => (droptarget = false)}
    ondrop={onDrop}
  >
    <span class="music-caret">{@html open ? ICON.folderOpen : ICON.folder}</span>
    <span class="music-folder-icon">{@html open ? SVG.folderOpen : SVG.folder}</span>
    {#if renaming}
      <InlineInput
        value={node.name}
        oncommit={(v) => { renaming = false; void renameFolder(aid, node.path, v); }}
        oncancel={() => (renaming = false)}
      />
    {:else}
      <span class="music-folder-name">{node.name}</span>
    {/if}
    <span class="music-folder-count">{node.totalFiles}</span>
    <button class="music-mini" type="button" title="Upload mp3" onclick={(e) => { e.stopPropagation(); triggerUpload(aid, node.path); }}>{@html SVG.upload}</button>
    <button class="music-mini" type="button" title="New subfolder" onclick={(e) => { e.stopPropagation(); creating = true; }}>{@html ICON.plus}</button>
    <button class="music-mini" type="button" title="Rename" onclick={(e) => { e.stopPropagation(); renaming = true; }}>{@html ICON.rename}</button>
    <ArmDelete title="Delete folder" onconfirm={() => void deleteFolder(aid, node.path)} />
  </div>
  {#if creating}
    <div class="music-create-row">
      <InlineInput
        placeholder="New folder name…"
        oncommit={(v) => { creating = false; void createFolder(aid, node.path, v); }}
        oncancel={() => (creating = false)}
      />
    </div>
  {/if}
  {#if open}
    <div class="music-folder-body">
      {#each here as s (s.filename)}
        <TrackRow song={s} />
      {/each}
      {#each node.children as child (child.path)}
        <Self {aid} node={child} {songs} />
      {/each}
    </div>
  {/if}
</div>
