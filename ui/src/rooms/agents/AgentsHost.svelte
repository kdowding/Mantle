<script lang="ts">
  // Room host — mounts whichever agent-CRUD modal is active. Keyed so each
  // open is a fresh component (fields seed once). Delete stacks over edit.
  import { agentModals } from './agents.svelte';
  import CreateAgentModal from './CreateAgentModal.svelte';
  import EditAgentModal from './EditAgentModal.svelte';
  import DeleteAgentModal from './DeleteAgentModal.svelte';
</script>

{#if agentModals.create}
  <CreateAgentModal />
{/if}

{#if agentModals.editId}
  {#key agentModals.editId}
    <EditAgentModal agentId={agentModals.editId} />
  {/key}
{/if}

{#if agentModals.deleteId}
  {#key agentModals.deleteId}
    <DeleteAgentModal agentId={agentModals.deleteId} />
  {/key}
{/if}
