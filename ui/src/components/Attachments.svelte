<script lang="ts">
  // Renders a message's attachments: images (→ lightbox), inline audio/video,
  // and file cards. A card click opens the in-app preview (PDF doc viewer /
  // format-aware text viewer via lib/viewers.ts); the ⭳ stays a direct download.
  import { overlay, type Attachment } from '../lib/state.svelte';
  import { formatSize } from '../lib/attachments';
  import { openFilePreview } from '../lib/viewers';

  let { items }: { items: Attachment[] } = $props();
</script>

<div class="attachments">
  {#each items as a (a.url)}
    {#if a.kind === 'image'}
      <button class="att-image-btn" type="button" onclick={() => (overlay.lightboxUrl = a.url)}>
        <img class="att-image" src={a.url} alt={a.name} loading="lazy" />
      </button>
    {:else if a.kind === 'audio'}
      <div class="att-media">
        <audio controls preload="metadata" src={a.url}></audio>
        <div class="att-medialabel">{a.name}</div>
      </div>
    {:else if a.kind === 'video'}
      <div class="att-media">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video controls preload="metadata" src={a.url}></video>
      </div>
    {:else}
      <div class="att-card">
        <button class="att-open" type="button" onclick={() => openFilePreview(a)}>
          <span class="att-icon">▤</span>
          <span class="att-info">
            <span class="att-name">{a.name}</span>
            <span class="att-size">{formatSize(a.size)}</span>
          </span>
        </button>
        <a class="att-dl" href={a.url} download={a.name} title="Download" aria-label="Download {a.name}">⭳</a>
      </div>
    {/if}
  {/each}
</div>

<style>
  .attachments { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }

  .att-image-btn { padding: 0; background: none; border: none; cursor: zoom-in; align-self: flex-start; }
  .att-image {
    max-width: 320px;
    max-height: 320px;
    /* Floor for the lazy-load placeholder — off-screen images otherwise
       render as a 2px sliver until scrolled near (and then pop the layout). */
    min-width: 120px;
    min-height: 72px;
    background: var(--bg-tertiary);
    object-fit: contain;
    border: 1px solid var(--border-strong);
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
    display: block;
  }

  .att-media { max-width: 480px; }
  .att-media audio, .att-media video { width: 100%; max-height: 360px; background: #000; }
  .att-medialabel { font-size: 11px; color: var(--text-muted); margin-top: 3px; }

  .att-card {
    display: flex;
    align-items: stretch;
    max-width: 360px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-left: 2px solid var(--accent);
    transition: border-color 0.15s, background 0.15s;
  }
  .att-card:hover { border-color: var(--accent); background: var(--accent-faint); }
  .att-open {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
    padding: 8px 11px;
    background: transparent;
    border: none;
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
  }
  .att-icon { color: var(--accent); font-size: 16px; }
  .att-info { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .att-name { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .att-size { font-size: 10px; color: var(--text-muted); font-family: var(--font-mono); }
  .att-dl {
    display: flex;
    align-items: center;
    padding: 0 10px;
    color: var(--text-muted);
    font-size: 14px;
    text-decoration: none;
    transition: color 0.15s;
  }
  .att-dl:hover { color: var(--accent); }
</style>
