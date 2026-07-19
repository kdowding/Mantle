<script lang="ts">
  // Always-mounted voice room host (App's only structural touch): owns the
  // lifecycle watches — these must outlive the profile-bar controls, which
  // unmount during the channel stage swap — and hosts the tune modal.
  import { ui, chat } from '../../lib/state.svelte';
  import { registerVoice, refreshAvailability, resetAudio, onConnectionLost, voice } from './voice.svelte';
  import { registerMic } from './mic.svelte';
  import VoiceTuneModal from './VoiceTuneModal.svelte';

  registerVoice(); // idempotent — WS seam + turn-option decorator
  registerMic(); // idempotent — TTS-pause coordination hooks

  // Agent switch: stop the previous agent's audio, re-derive availability
  // against the new agent's voice file. Also the first-mount fetch.
  $effect(() => {
    void ui.currentAgentId;
    resetAudio();
    void refreshAvailability();
  });

  // Session switch / new session: queued audio belongs to the old view.
  $effect(() => {
    void chat.sessionId;
    resetAudio();
  });

  // WS drop → both providers unavailable (server-side synth is gone);
  // reconnect → re-sync against server truth.
  $effect(() => {
    if (ui.wsConnected) void refreshAvailability();
    else onConnectionLost();
  });
</script>

{#if voice.tuneOpen}
  <VoiceTuneModal onclose={() => (voice.tuneOpen = false)} />
{/if}
