<!-- Track = a file row: cover thumb (or EQ glyph), title, hover-revealed mini
     actions (karaoke / prompt / download / rename / arm-delete). Click plays;
     drag moves it between folders within its bucket. -->
<script lang="ts">
  import {
    music, playSong, sameSong, trKey, coverUrl, downloadUrl,
    renameTrack, deleteTrack, transcribeTrack, viewLyrics, viewPrompt,
    type Song,
  } from './music.svelte';
  import { ICON, SVG } from './icons';
  import InlineInput from './InlineInput.svelte';
  import ArmDelete from './ArmDelete.svelte';
  import { getFeature } from '../../lib/state.svelte';

  let { song }: { song: Song } = $props();

  let renaming = $state(false);
  let dragging = $state(false);

  const isActive = $derived(sameSong(music.current, song));
  const transcribingThis = $derived(!!music.transcribing[trKey(song)]);
  // Transcription needs Whisper STT; viewing existing lyrics doesn't. Block only
  // the transcribe path when STT isn't ready (undefined while loading ⇒ allow).
  const sttFeature = $derived(getFeature('stt'));
  const transcribeBlocked = $derived(!song.hasLyrics && !!sttFeature && !sttFeature.ready);

  function onRowClick(): void {
    if (!renaming) playSong(song);
  }

  function onCc(e: MouseEvent): void {
    e.stopPropagation();
    if (music.transcribing[trKey(song)]) return; // already running
    if (transcribeBlocked) return; // STT off — nothing to do (button is disabled)
    if (song.hasLyrics) void viewLyrics(song);
    else void transcribeTrack(song);
  }

  function onDragStart(e: DragEvent): void {
    music.dragged = { agentId: song.agentId, filename: song.filename };
    dragging = true;
    try {
      e.dataTransfer?.setData('text/plain', song.filename);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    } catch { /* ignore */ }
  }

  function onDragEnd(): void {
    dragging = false;
    music.dragged = null;
  }
</script>

<div
  class="music-track"
  class:is-active={isActive}
  class:has-lyrics={song.hasLyrics}
  class:has-prompt={song.hasPrompt}
  class:is-dragging={dragging}
  role="button"
  tabindex="0"
  draggable={!renaming}
  onclick={onRowClick}
  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(); } }}
  ondragstart={onDragStart}
  ondragend={onDragEnd}
>
  {#if song.hasCover}
    <!-- album-art thumbnail in place of the EQ glyph when a track has a cover -->
    <img class="music-track-thumb" src={coverUrl(song)} alt="" loading="lazy" />
  {:else}
    <span class="music-track-icon">{@html SVG.track}</span>
  {/if}
  {#if renaming}
    <InlineInput
      value={song.title}
      oncommit={(v) => { renaming = false; void renameTrack(song, v); }}
      oncancel={() => (renaming = false)}
    />
  {:else}
    <span class="music-track-title">{song.title}</span>
  {/if}
  <button class="music-mini music-track-cc" type="button" disabled={transcribeBlocked} title={transcribeBlocked ? (sttFeature?.setupHint ?? 'Speech recognition is off — enable voice to transcribe lyrics') : (song.hasLyrics ? 'View lyrics' : 'Transcribe (karaoke)')} onclick={onCc}>
    {#if transcribingThis}<span class="music-spin"></span>{:else}{@html SVG.cc}{/if}
  </button>
  <button class="music-mini music-track-prompt" type="button" title={song.hasPrompt ? 'View prompt' : 'No saved prompt'} onclick={(e) => { e.stopPropagation(); void viewPrompt(song); }}>{@html SVG.prompt}</button>
  <a class="music-mini music-track-dl" title="Download" href={downloadUrl(song)} download onclick={(e) => e.stopPropagation()}>{@html ICON.download}</a>
  <button class="music-mini music-track-ren" type="button" title="Rename" onclick={(e) => { e.stopPropagation(); renaming = true; }}>{@html ICON.rename}</button>
  <ArmDelete cls="music-track-del" title="Delete" onconfirm={() => void deleteTrack(song)} />
</div>

<style>
  /* STT off ⇒ the transcribe (CC) action is disabled — dim it so it reads as
     unavailable rather than just inert on hover. */
  .music-track-cc:disabled { opacity: 0.3; cursor: default; }
</style>
