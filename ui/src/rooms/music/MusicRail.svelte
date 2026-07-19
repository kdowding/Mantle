<!-- Music room root — the right column of the chat stage: a vertical spine tab
     (the accordion handle, always visible) plus an expanding panel. Collapsed
     it's just the spine; clicking it opens the panel and the conversation
     shrinks to give it room (the rail's width transition replaces the old
     #chat-area grid-column animation). Port of ui/music.js's shell. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { music, setOpen, fetchTray, registerMusicWs, registerUploadInput, onUploadPicked } from './music.svelte';
  import { ICON } from './icons';
  import NowPlaying from './NowPlaying.svelte';
  import GenerateForm from './GenerateForm.svelte';
  import LyricsPanel from './LyricsPanel.svelte';
  import PromptPanel from './PromptPanel.svelte';
  import LibraryTree from './LibraryTree.svelte';

  let uploadEl: HTMLInputElement;

  $effect(() => registerMusicWs());

  onMount(() => {
    registerUploadInput(uploadEl);
    void fetchTray(); // gen-button visibility + library (even while collapsed)
    return () => registerUploadInput(null);
  });

  // Refresh the library while the panel is open (covers external moves the
  // broadcast can't know about, e.g. files dropped into the folder on disk).
  $effect(() => {
    if (!music.open) return;
    const t = setInterval(() => { void fetchTray(); }, 15000);
    return () => clearInterval(t);
  });
</script>

<aside class="music-rail" class:is-open={music.open}>
  <button
    class="music-spine"
    class:is-playing={music.isPlaying}
    type="button"
    title="Music - click to open/close"
    onclick={() => setOpen(!music.open)}
  >
    <span class="music-spine-icon">{@html ICON.note}</span>
    <span class="music-spine-label">Music</span>
    <span class="music-spine-collapse" aria-hidden="true">&raquo;</span>
    <span class="music-spine-eq" aria-hidden="true"></span>
  </button>
  <div class="music-panel">
    <div class="music-head">
      <span class="music-title">MUSIC</span>
      <div class="music-head-actions">
        {#if music.canGenerate}
          <button
            class="music-gen-btn"
            class:is-active={music.genFormOpen}
            type="button"
            title="Generate a song"
            onclick={() => (music.genFormOpen = !music.genFormOpen)}
          >{@html ICON.plus} Generate</button>
        {/if}
        <button class="music-close" type="button" title="Collapse" onclick={() => setOpen(false)}>{@html ICON.close}</button>
      </div>
    </div>
    <NowPlaying />
    <GenerateForm />
    {#if music.lyricsPanel}
      <LyricsPanel />
    {/if}
    {#if music.promptPanel}
      <PromptPanel />
    {/if}
    <input
      class="music-search"
      type="text"
      placeholder="Search tracks…"
      autocomplete="off"
      spellcheck="false"
      bind:value={music.search}
    />
    <LibraryTree />
    <input type="file" accept="audio/mpeg,.mp3" multiple hidden bind:this={uploadEl} onchange={() => void onUploadPicked()} />
    <!-- non-blocking error toast pinned to the bottom of the panel -->
    <div class="music-toast" class:is-visible={!!music.toast}>{music.toast}</div>
  </div>
</aside>

<style>
  /* Mantle idiom: angular clip-path cuts, zero border-radius, neon palette,
     agent-accent (--accent) cascade, Rajdhani chrome. Carried class-for-class
     from ui/styles-music.css. */
  .music-rail {
    --music-rail-w: 46px;   /* collapsed = just the spine tab */
    --music-panel-w: 366px; /* open = spine + panel body */
    position: relative;
    display: flex;
    flex-direction: row;
    height: 100%;
    min-height: 0;
    flex: 0 0 var(--music-rail-w);
    width: var(--music-rail-w);
    overflow: hidden; /* clips the panel while collapsed */
    background: var(--bg-secondary);
    font-family: var(--font-sans);
    color: var(--text-primary);
    z-index: 1; /* below floating popovers so the profile bar's dropdowns win */
    transition: flex-basis 0.26s cubic-bezier(0.22, 0.61, 0.36, 1), width 0.26s cubic-bezier(0.22, 0.61, 0.36, 1);
  }
  .music-rail.is-open {
    flex-basis: var(--music-panel-w);
    width: var(--music-panel-w);
  }
  /* neon edge line on the rail's inner (left) border — separates it from the chat */
  .music-rail::before {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    width: 1px;
    height: 100%;
    background: linear-gradient(180deg, transparent, var(--accent), transparent);
    opacity: 0.5;
    pointer-events: none;
    z-index: 2;
  }

  /* ── Spine (the accordion tab — always visible, toggles open/closed) ───── */
  .music-spine {
    flex: 0 0 var(--music-rail-w);
    width: var(--music-rail-w);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    padding: 14px 0;
    cursor: pointer;
    background: var(--bg-secondary);
    border: none;
    color: var(--text-muted);
    transition: color 0.15s, background 0.15s;
  }
  .music-spine:hover { color: var(--accent); background: var(--accent-faint); }
  .music-rail.is-open .music-spine { color: var(--accent); background: var(--accent-dim); }
  .music-spine-icon { font-size: 18px; line-height: 1; }
  .music-spine-label {
    writing-mode: vertical-rl;
    text-orientation: mixed;
    transform: rotate(180deg);
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 12px;
    letter-spacing: 0.3em;
    text-transform: uppercase;
    text-shadow: 1px 0 var(--accent-pink), -1px 0 var(--accent); /* subtle chroma */
  }
  /* When open, the spine becomes a collapse handle — drop the redundant
     vertical label (the panel header already says MUSIC), show a chevron. */
  .music-spine-collapse {
    display: none;
    font-size: 17px;
    line-height: 1;
    color: var(--accent);
    text-shadow: 0 0 8px var(--accent-glow);
  }
  .music-rail.is-open .music-spine-label { display: none; }
  .music-rail.is-open .music-spine-collapse { display: block; }
  .music-spine-eq { /* now-playing pulse dot */
    width: 8px;
    height: 8px;
    background: var(--accent);
    flex-shrink: 0;
    clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
    opacity: 0;
    transition: opacity 0.2s;
  }
  .music-spine.is-playing .music-spine-eq { opacity: 1; animation: music-pulse 1.1s ease-in-out infinite; }
  @keyframes music-pulse {
    0%, 100% { transform: scale(0.7); opacity: 0.5; }
    50% { transform: scale(1.1); opacity: 1; }
  }

  /* ── Panel (fixed-width body revealed beside the spine when open) ──────── */
  .music-panel {
    position: relative; /* anchor for the error toast */
    flex: 0 0 calc(var(--music-panel-w) - var(--music-rail-w));
    width: calc(var(--music-panel-w) - var(--music-rail-w));
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    background: var(--bg-secondary);
    border-left: 1px solid var(--border);
  }

  /* ── Header ────────────────────────────────────────────────────────────── */
  .music-head {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 13px 14px 11px;
    border-bottom: 1px solid var(--border);
    background: linear-gradient(180deg, var(--accent-faint), transparent);
  }
  .music-head::before { /* HUD corner bracket */
    content: "";
    position: absolute;
    top: 6px;
    left: 6px;
    width: 8px;
    height: 8px;
    border-top: 1px solid var(--accent);
    border-left: 1px solid var(--accent);
    opacity: 0.7;
    pointer-events: none;
  }
  .music-title {
    position: relative;
    padding-left: 15px;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 14px;
    letter-spacing: 0.34em;
    color: var(--text-primary);
    text-shadow: 1px 0 var(--accent-pink), -1px 0 var(--accent); /* subtle chroma */
  }
  .music-title::before { /* mini equalizer mark */
    content: "";
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    width: 8px;
    height: 11px;
    background:
      linear-gradient(var(--accent), var(--accent)) 0 100% / 2px 6px no-repeat,
      linear-gradient(var(--accent), var(--accent)) 3px 100% / 2px 11px no-repeat,
      linear-gradient(var(--accent), var(--accent)) 6px 100% / 2px 8px no-repeat;
  }
  .music-head-actions { display: flex; align-items: center; gap: 6px; }
  .music-gen-btn {
    font-family: var(--font-display);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 5px 11px;
    cursor: pointer;
    color: var(--bg-primary);
    background: var(--accent);
    border: none;
    clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px);
    transition: box-shadow 0.15s, transform 0.1s;
  }
  .music-gen-btn:hover { box-shadow: 0 0 16px var(--accent-glow); }
  .music-gen-btn:active { transform: translateY(1px); }
  .music-gen-btn.is-active { background: var(--accent-dim); color: var(--accent); box-shadow: inset 0 0 10px var(--accent-dim); }
  .music-close {
    width: 27px;
    height: 27px;
    display: grid;
    place-items: center;
    line-height: 1;
    font-size: 16px;
    cursor: pointer;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid var(--border);
    clip-path: polygon(5px 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%, 0 5px);
    transition: color 0.15s, border-color 0.15s, box-shadow 0.15s;
  }
  .music-close:hover { color: var(--accent-pink); border-color: var(--accent-pink); box-shadow: 0 0 10px rgba(255, 45, 124, 0.25); }

  /* ── Search ────────────────────────────────────────────────────────────── */
  .music-search {
    margin: 11px 14px 8px;
    padding: 8px 11px;
    font-family: var(--font-sans);
    font-size: 12px;
    color: var(--text-primary);
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .music-search::placeholder { color: var(--text-muted); }
  .music-search:focus { outline: none; border-color: var(--accent-edge); box-shadow: 0 0 10px var(--accent-dim); }

  /* non-blocking error toast pinned to the bottom of the panel */
  .music-toast {
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: 10px;
    z-index: 3;
    padding: 8px 11px;
    font-size: 11px;
    line-height: 1.4;
    color: var(--accent-pink);
    background: var(--bg-primary);
    border: 1px solid var(--accent-pink);
    box-shadow: 0 0 14px rgba(255, 45, 124, 0.3);
    clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
    opacity: 0;
    transform: translateY(6px);
    pointer-events: none;
    transition: opacity 0.2s, transform 0.2s;
  }
  .music-toast.is-visible { opacity: 1; transform: translateY(0); }

  @media (prefers-reduced-motion: reduce) {
    .music-rail { transition: none; }
    .music-spine.is-playing .music-spine-eq { animation: none; }
  }

  /* ── Mobile (≤768px) — ported from styles-music.css's media block ────────
     Collapsed: the rail takes no width and the spine becomes a floating tab
     pinned to the right edge at mid-height, so the conversation keeps full
     width. Open: the rail overlays the MESSAGES row (absolute inset 0 in
     Chat's .chat-row, position:relative — the composer below stays visible);
     the tab hides and the header ✕ closes. App collapses on navigation. */
  @media (max-width: 768px) {
    .music-rail {
      flex-basis: 0;
      width: 0;
      overflow: visible; /* the fixed spine must escape the 0-width rail */
      transition: none;  /* width no longer animates — the overlay swaps in */
    }
    .music-rail::before { display: none; } /* no inline seam to mark */

    .music-spine {
      position: fixed;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      z-index: 8; /* over messages, clear of the profile bar's dropdown (z:20) */
      flex: none;
      width: auto;
      height: auto;
      padding: 14px 7px;
      gap: 8px;
      justify-content: center;
      border: 1px solid var(--border-strong);
      border-right: none;
      box-shadow: -4px 0 16px rgba(0, 0, 0, 0.45);
      /* tab attached to the right edge — cut the two left (inward) corners */
      clip-path: polygon(9px 0, 100% 0, 100% 100%, 9px 100%, 0 calc(100% - 9px), 0 9px);
    }
    /* touch has no hover; keep the resting look so a tap doesn't stick lit */
    .music-spine:hover { background: var(--bg-secondary); color: var(--text-muted); }
    .music-spine:active { background: var(--accent-dim); color: var(--accent); }
    .music-spine-label { font-size: 11px; letter-spacing: 0.24em; }

    .music-rail:not(.is-open) .music-panel { display: none; }

    .music-rail.is-open {
      position: absolute;
      inset: 0;
      width: auto;
      z-index: 6;
      overflow: hidden;
    }
    .music-rail.is-open .music-panel { flex: 1 1 auto; width: auto; border-left: none; }
    .music-rail.is-open .music-spine { display: none; }
  }
</style>
