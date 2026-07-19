<script lang="ts">
  // Dumb :shortcode: suggestion strip — renders above the composer; the
  // composer owns the scan state and keyboard nav (arrows/Enter/Tab/Esc).
  // mousedown (not click) so picking doesn't blur the textarea.
  import type { ShortcodeMatch } from './shortcodes';

  let { matches, activeIndex, onpick, onhover }: {
    matches: ShortcodeMatch[];
    activeIndex: number;
    onpick: (m: ShortcodeMatch) => void;
    onhover: (i: number) => void;
  } = $props();
</script>

{#if matches.length > 0}
  <div class="ac">
    {#each matches as m, i (m.name)}
      <button
        class="row"
        class:active={i === activeIndex}
        type="button"
        onmousedown={(e) => { e.preventDefault(); onpick(m); }}
        onmouseenter={() => onhover(i)}
      >
        <span class="char">{m.emoji}</span>
        <span class="name">:{m.name}:</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .ac {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 60px;
    z-index: 30;
    min-width: 220px;
    padding: 4px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-strong);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    clip-path: polygon(0 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 5px 8px;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
  }
  .row.active { background: var(--accent-faint); border-left-color: var(--accent); }

  .char { font-size: 16px; line-height: 1; }
  .name { font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); }
  .row.active .name { color: var(--accent); }
</style>
