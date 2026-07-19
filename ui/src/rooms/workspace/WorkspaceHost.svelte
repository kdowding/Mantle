<script lang="ts">
  // Room host — mounts the workspace modal when open.
  import { workspace } from './workspace.svelte';
  import WorkspaceModal from './WorkspaceModal.svelte';
</script>

{#if workspace.open}
  <WorkspaceModal />
{/if}
