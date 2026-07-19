<script lang="ts">
  // Englyph store choice: isolated (per-agent dir) / share an existing path /
  // custom path. The share option hides when no existing path is available.
  import type { EnglyphMode } from './agents.svelte';

  let { mode = $bindable('isolated'), customPath = $bindable(''), sharePath = null }: {
    mode?: EnglyphMode;
    customPath?: string;
    sharePath?: string | null;
  } = $props();
</script>

<div class="picker">
  <!-- .section comes from the global form kit (this always sits in a .form) -->
  <div class="section">Englyph Memory Store</div>
  <label class="option">
    <input type="radio" bind:group={mode} value="isolated" />
    <span class="opt-body">
      <span class="opt-label">Isolated</span>
      <span class="opt-note">Own store under ~/.rev-mantle/englyph-&lt;id&gt;</span>
    </span>
  </label>
  {#if sharePath}
    <label class="option">
      <input type="radio" bind:group={mode} value="share" />
      <span class="opt-body">
        <span class="opt-label">Share with existing agents</span>
        <span class="opt-note">{sharePath}</span>
      </span>
    </label>
  {/if}
  <label class="option">
    <input type="radio" bind:group={mode} value="custom" />
    <span class="opt-body">
      <span class="opt-label">Custom path</span>
      <input
        class="custom"
        type="text"
        bind:value={customPath}
        disabled={mode !== 'custom'}
        placeholder="C:\path\to\englyph-store"
      />
    </span>
  </label>
</div>

<style>
  .picker { display: flex; flex-direction: column; gap: 6px; }
  .option { display: flex; align-items: flex-start; gap: 9px; cursor: pointer; }
  .option input[type='radio'] { margin-top: 3px; accent-color: var(--accent); }
  .opt-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .opt-label { font-size: 13px; color: var(--text-primary); }
  .opt-note {
    font-size: 10.5px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    word-break: break-all;
  }
  .custom {
    padding: 5px 8px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .custom:disabled { opacity: 0.4; }
  .custom:focus { outline: none; border-color: var(--accent); }
</style>
