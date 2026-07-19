<script lang="ts">
  // Profile-bar voice cluster: chatterbox toggle ♬, xAI toggle ✧, voice
  // pickers (file / catalog), tune gear. Mounted from ProfileBar with one
  // line; all state + actions live in voice.svelte.ts.
  import Popover from '../../components/Popover.svelte';
  import { voice, toggleChatterbox, toggleXai, selectVoiceFile, selectXaiVoice, voiceLabelFromFile } from './voice.svelte';

  let filePickerOpen = $state(false);
  let xaiPickerOpen = $state(false);

  const cbLabel = $derived(
    voice.cb === 'on' ? 'voice on'
      : voice.cb === 'loading' ? 'loading…'
        : voice.cb === 'failed' ? 'failed'
          : 'voice',
  );
  const cbTitle = $derived(
    voice.cb === 'unavailable'
      ? (voice.sidecarReady ? 'No voice file for this agent - drop a wav in voices/' : 'Voice sidecar is not running')
      : voice.cb === 'off' ? 'Voice replies off - click to load TTS (≈30-60s first time)'
        : voice.cb === 'loading' ? 'Warming Chatterbox - usually 30-60s'
          : voice.cb === 'on' ? 'Voice replies on (Chatterbox) - click to disable + free VRAM'
            : 'Voice load failed - check mantle logs and try again',
  );
  const xaiTitle = $derived(
    voice.xai === 'unavailable' ? 'xAI TTS unavailable - needs a Grok API key'
      : voice.xai === 'on' ? 'xAI voice on - click to disable'
        : 'xAI hosted voice - click to enable (mutually exclusive with Chatterbox)',
  );

  function pickFile(f: string): void {
    void selectVoiceFile(f);
    filePickerOpen = false;
  }
  function pickXai(v: string): void {
    void selectXaiVoice(v);
    xaiPickerOpen = false;
  }
</script>

<div class="voice-cluster">
  <button
    class="chip"
    class:active={voice.cb === 'on'}
    class:loading={voice.cb === 'loading'}
    class:failed={voice.cb === 'failed'}
    type="button"
    disabled={voice.cb === 'unavailable' || voice.cb === 'loading'}
    title={cbTitle}
    onclick={toggleChatterbox}
  >♬ {cbLabel}</button>

  <button
    class="chip"
    class:active={voice.xai === 'on'}
    type="button"
    disabled={voice.xai === 'unavailable'}
    title={xaiTitle}
    onclick={toggleXai}
  >✧ {voice.xai === 'on' ? 'xai on' : 'xai'}</button>

  {#if voice.sidecarReady && voice.availableVoices.length > 0}
    <Popover bind:open={filePickerOpen} width={250}>
      {#snippet trigger({ toggle })}
        <button class="chip" type="button" title="Voice file for this agent" onclick={toggle}>
          {voice.selectedVoice ? voiceLabelFromFile(voice.selectedVoice) : '(none)'} ▾
        </button>
      {/snippet}
      <div class="v-list">
        {#each voice.availableVoices as f (f)}
          <button class="v-row" class:active={f === voice.selectedVoice} type="button" onclick={() => pickFile(f)}>
            <span class="v-name">{voiceLabelFromFile(f)}</span>
            <span class="v-file">{f}</span>
          </button>
        {/each}
      </div>
    </Popover>
  {/if}

  {#if voice.xaiAvailable && voice.xai === 'on'}
    <Popover bind:open={xaiPickerOpen} width={180}>
      {#snippet trigger({ toggle })}
        <button class="chip" type="button" title="xAI voice for this agent" onclick={toggle}>
          {voice.selectedXaiVoice} ▾
        </button>
      {/snippet}
      <div class="v-list">
        {#each voice.xaiVoiceCatalog as v (v)}
          <button class="v-row" class:active={v === voice.selectedXaiVoice} type="button" onclick={() => pickXai(v)}>
            <span class="v-name">{v}</span>
          </button>
        {/each}
      </div>
    </Popover>
  {/if}

  {#if voice.cb === 'on' || voice.cb === 'off' || voice.cb === 'failed'}
    <button class="chip" type="button" title="Voice tuning (temperature / CFG / exaggeration)" onclick={() => (voice.tuneOpen = true)}>⚙</button>
  {/if}
</div>

<style>
  .voice-cluster { display: flex; gap: 6px; align-items: center; }

  /* Same chip language as ProfileBar's toggles. */
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 9px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
  }
  .chip:hover:not(:disabled) { border-color: var(--accent); color: var(--text-secondary); }
  .chip.active { border-color: var(--accent); color: var(--accent); background: var(--accent-faint); }
  .chip:disabled { opacity: 0.45; cursor: default; }
  .chip.loading { color: var(--warning); border-color: var(--warning); animation: voice-load-pulse 1.4s ease-in-out infinite; }
  .chip.failed { color: var(--error); border-color: var(--error); }
  @keyframes voice-load-pulse {
    0%, 100% { opacity: 0.55; }
    50% { opacity: 1; }
  }

  .v-list { display: flex; flex-direction: column; gap: 2px; }
  .v-row {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 6px 9px;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    color: var(--text-secondary);
    text-align: left;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .v-row:hover { background: var(--accent-faint); }
  .v-row.active { border-left-color: var(--accent); background: var(--accent-faint); }
  .v-name { font-size: 13px; color: var(--text-primary); }
  .v-row.active .v-name { color: var(--accent); }
  .v-file { font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); }
</style>
