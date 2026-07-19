<script lang="ts">
  // Sidebar cron panel — accordion header (enabled/total + add) over the job
  // cards. Reloads itself on agent switch; App just mounts it (bolt-on).
  import { ui } from '../../lib/state.svelte';
  import { cron, loadJobs, openJobInDeck } from './cron.svelte';
  import CronJobCard from './CronJobCard.svelte';
  import { accordionSlide } from '../../lib/crt';

  const enabledCount = $derived(cron.jobs.filter((j) => j.enabled).length);

  $effect(() => {
    void ui.currentAgentId; // reload on agent switch (and first mount)
    void loadJobs();
  });
</script>

<div class="cron-panel">
  <div class="side-sect">
    <button class="side-toggle" type="button" onclick={() => (cron.open = !cron.open)}>
      <span class="arrow" class:open={cron.open}>▸</span>
      <span class="label">// cron</span>
      <span class="count">{enabledCount}/{cron.jobs.length}</span>
    </button>
    <button class="side-sect-btn" type="button" title="Create cron job" aria-label="Create cron job" onclick={() => openJobInDeck(null)}>+</button>
    <button class="side-sect-btn" type="button" title="Open in systems deck" aria-label="Manage cron jobs" onclick={() => (ui.deckTab = 'cron')}>⤢</button>
  </div>

  {#if cron.open}
    <div class="cron-list" transition:accordionSlide>
      {#each cron.jobs as job (job.id)}
        <CronJobCard {job} />
      {/each}
      {#if cron.jobs.length === 0}
        <div class="empty">No cron jobs. Click + to create one.</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .cron-panel { flex-shrink: 0; display: flex; flex-direction: column; min-height: 0; }

  .cron-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 6px;
    max-height: 38vh;
    overflow-y: auto;
  }

  .empty { color: var(--text-muted); font-size: 12px; padding: 6px 2px; }
</style>
