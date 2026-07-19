<script lang="ts">
  // Composer mic toggle — voice input (Silero VAD + Whisper). Shown whenever
  // the voice sidecar is up (STT is whisper-only; xAI doesn't help here).
  // Independent of the TTS-out toggle by design.
  import { voice } from './voice.svelte';
  import { mic, toggleMic, MIC_TITLES } from './mic.svelte';

  const disabled = $derived(mic.state === 'loading' || mic.state === 'transcribing');
</script>

{#if voice.sidecarReady}
  <button
    class="mic-btn"
    class:loading={mic.state === 'loading'}
    class:listening={mic.state === 'listening'}
    class:capturing={mic.state === 'capturing'}
    class:transcribing={mic.state === 'transcribing'}
    class:paused={mic.state === 'paused'}
    class:failed={mic.state === 'failed'}
    type="button"
    {disabled}
    title={MIC_TITLES[mic.state]}
    aria-label="Voice input"
    onclick={toggleMic}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  </button>
{/if}

<style>
  /* Same chrome as the composer's attach button. */
  .mic-btn {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    cursor: pointer;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
    transition: border-color 0.2s, background 0.2s, color 0.2s;
  }
  .mic-btn:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-faint); }
  .mic-btn:disabled { cursor: default; }

  .mic-btn.loading { color: var(--warning); border-color: var(--warning); animation: mic-pulse 1.4s ease-in-out infinite; }
  .mic-btn.listening {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-faint);
    box-shadow: 0 0 8px var(--accent-dim);
    animation: mic-pulse 2.4s ease-in-out infinite;
  }
  .mic-btn.capturing {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-dim);
    box-shadow: 0 0 12px var(--accent-glow);
    animation: mic-pulse 0.9s ease-in-out infinite;
  }
  .mic-btn.transcribing { color: var(--accent-purple); border-color: var(--accent-purple); animation: mic-pulse 0.9s ease-in-out infinite; }
  .mic-btn.paused { color: var(--warning); border-color: var(--warning); background: rgba(255, 170, 0, 0.06); }
  .mic-btn.failed { color: var(--error); border-color: var(--error); }

  @keyframes mic-pulse {
    0%, 100% { opacity: 0.65; }
    50% { opacity: 1; }
  }
</style>
