<script lang="ts">
  // Sidebar skills panel — accordion over the agent's skill list with
  // enable/disable switches. Reloads itself on agent switch; App just mounts
  // it (bolt-on). Spec: app.js loadAgentSkills/renderSkills/toggleSkill.
  import { ui } from '../../lib/state.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { skills, loadSkills, toggleSkill } from './skills.svelte';
  import { accordionSlide } from '../../lib/crt';

  const enabledCount = $derived(skills.list.filter((s) => s.enabled).length);

  $effect(() => {
    void ui.currentAgentId; // reload on agent switch (and first mount)
    void loadSkills();
  });
</script>

<div class="skills-panel">
  <div class="side-sect">
    <button class="side-toggle" type="button" onclick={() => (skills.open = !skills.open)}>
      <span class="arrow" class:open={skills.open}>▸</span>
      <span class="label">// skills</span>
      {#if skills.list.length}<span class="count">{enabledCount}/{skills.list.length}</span>{/if}
    </button>
    <button class="side-sect-btn" type="button" title="Open in systems deck - create, edit, manage" aria-label="Manage skills" onclick={() => (ui.deckTab = 'skills')}>⤢</button>
  </div>

  {#if skills.open}
    <div class="sk-list" transition:accordionSlide>
      {#each skills.list as skill (skill.name)}
        <div class="sk-item" title={skill.description ?? ''}>
          <div class="sk-info">
            <span class="sk-name" class:off={!skill.enabled}>{skill.name}</span>
            <span class="sk-source">{skill.source}{skill.agentOverride ? ' · override' : ''}</span>
          </div>
          <Toggle
            checked={skill.enabled}
            label="Enable {skill.name}"
            onchange={(v) => void toggleSkill(skill, v)}
          />
        </div>
      {/each}
      {#if skills.error}
        <div class="empty error">{skills.error}</div>
      {:else if skills.list.length === 0}
        <div class="empty">{skills.loading ? 'Loading…' : 'No skills discovered.'}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .skills-panel { flex-shrink: 0; display: flex; flex-direction: column; min-height: 0; }

  .sk-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 6px;
    max-height: 30vh;
    overflow-y: auto;
  }

  .sk-item {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 8px 10px;
    border-left: 2px solid transparent;
    transition: background 0.12s, border-color 0.12s;
  }
  .sk-item:hover { background: var(--bg-tertiary); border-left-color: var(--border-strong); }

  .sk-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .sk-name {
    font-size: 14px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sk-name.off { color: var(--text-muted); }
  .sk-source {
    font-family: var(--font-terminal);
    font-size: 10px;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    color: var(--text-muted);
    opacity: 0.75;
  }

  .empty { color: var(--text-muted); font-size: 13px; padding: 6px 2px; }
  .empty.error { color: var(--error); }
</style>
