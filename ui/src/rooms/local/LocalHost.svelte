<script lang="ts">
  // Always-mounted local room host: registers the telemetry seams, polls
  // runtime status while the local backend is selected, and hosts the two
  // modals (settings + HF browser).
  import { prefs } from '../../lib/state.svelte';
  import { local, registerLocal, fetchLocalStatus } from './local.svelte';
  import LocalModal from './LocalModal.svelte';
  import HfBrowserModal from './HfBrowserModal.svelte';

  registerLocal(); // idempotent — turn-options clock + text_delta/message_end observers

  // Poll while local is the live backend so the chip's state/model/telemetry
  // stay fresh (loads can be triggered by a turn, not just the modal).
  $effect(() => {
    if (prefs.backendId !== 'local') return;
    void fetchLocalStatus();
    const t = setInterval(() => void fetchLocalStatus(), 5000);
    return () => clearInterval(t);
  });
</script>

{#if local.open}
  <LocalModal onclose={() => (local.open = false)} />
{/if}
{#if local.browserOpen}
  <HfBrowserModal onclose={() => (local.browserOpen = false)} />
{/if}
