<script lang="ts">
  // Profile-bar call trigger: ✆ chip + the xAI realtime voice picker.
  // Visible only when the server reports the realtime feature (flag + Grok
  // API key). Starting a call swaps the chat surface for CallOverlay.
  import Popover from '../../components/Popover.svelte';
  import { getFeature } from '../../lib/state.svelte';
  import { call, startCall, setCallVoice, CALL_VOICES } from './call.svelte';

  let pickerOpen = $state(false);

  // The ONE readiness model (realtime = flag + Grok key), the same source as the
  // memory/STT gates — refreshes live on a feature toggle instead of waiting for
  // the next /api/config fetch. (undefined while readiness loads ⇒ hidden.)
  const available = $derived(getFeature('realtime')?.ready === true);

  function pick(v: string): void {
    setCallVoice(v);
    pickerOpen = false;
  }
</script>

{#if available}
  <div class="call-cluster">
    <button class="chip" type="button" disabled={call.active} title="Start a realtime voice call ({call.voice})" onclick={() => void startCall()}>
      ✆ call
    </button>
    <Popover bind:open={pickerOpen} width={150}>
      {#snippet trigger({ toggle })}
        <button class="chip" type="button" title="Call voice" onclick={toggle}>{call.voice} ▾</button>
      {/snippet}
      <div class="v-list">
        {#each CALL_VOICES as v (v)}
          <button class="v-row" class:active={v === call.voice} type="button" onclick={() => pick(v)}>{v}</button>
        {/each}
      </div>
    </Popover>
  </div>
{/if}

<style>
  .call-cluster { display: flex; gap: 6px; align-items: center; }

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
  .chip:disabled { opacity: 0.45; cursor: default; }

  .v-list { display: flex; flex-direction: column; gap: 2px; }
  .v-row {
    padding: 6px 9px;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    color: var(--text-secondary);
    text-align: left;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .v-row:hover { background: var(--accent-faint); }
  .v-row.active { border-left-color: var(--accent); background: var(--accent-faint); color: var(--accent); }
</style>
