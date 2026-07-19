<script lang="ts">
  // Host for confirmDialog() requests — mount once in App.
  import Modal from './Modal.svelte';
  import Button from './Button.svelte';
  import { confirmState, settleConfirm } from './confirm.svelte';
</script>

{#if confirmState.active}
  {@const c = confirmState.active}
  <Modal open title={c.title} size="sm" onclose={() => settleConfirm(false)}>
    <p class="confirm-message">{c.message}</p>
    {#snippet footer()}
      <Button variant="ghost" onclick={() => settleConfirm(false)}>{c.cancelText}</Button>
      <Button variant={c.danger ? 'danger' : 'primary'} onclick={() => settleConfirm(true)}>
        {c.confirmText}
      </Button>
    {/snippet}
  </Modal>
{/if}

<style>
  .confirm-message {
    margin: 0;
    font-size: 14px;
    line-height: 1.5;
    color: var(--text-primary);
    white-space: pre-wrap;
  }
</style>
