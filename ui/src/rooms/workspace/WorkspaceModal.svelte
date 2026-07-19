<script lang="ts">
  // Workspace files modal — a QUICK ACTION: toggle ## sections on/off across the
  // four identity files, and view the assembled system prompt. Full editing
  // (raw markdown + ✦ assist + create-from-template) lives in the Personality
  // systems-deck tab; this modal stays the glance/quick-toggle tier.
  import Modal from '../../components/Modal.svelte';
  import { workspace, PREVIEW_TAB, switchTab, closeWorkspace } from './workspace.svelte';
  import FilePane from './FilePane.svelte';
  import PromptPreview from './PromptPreview.svelte';

  // Only the section-toggleable identity files belong in this quick-toggle
  // surface (MEMORY/CALL aren't section-toggleable — they're managed in the tab).
  const toggleFiles = $derived(workspace.files.filter((f) => f.toggleable));

  function badge(name: string): string {
    const f = workspace.files.find((x) => x.name === name);
    if (!f || !f.exists || f.sections.length === 0) return '';
    const on = f.sections.filter((s) => s.enabled).length;
    return `${on}/${f.sections.length}`;
  }
</script>

<Modal open title="Workspace Files" size="xl" tall onclose={closeWorkspace}>
  <div class="wf">
    <div class="tabs">
      {#each toggleFiles as f (f.name)}
        <button class="tab" class:active={workspace.tab === f.name} class:missing={!f.exists} type="button" onclick={() => void switchTab(f.name)}>
          {f.name.replace(/\.md$/, '')}
          {#if badge(f.name)}<span class="badge">{badge(f.name)}</span>{/if}
        </button>
      {/each}
      <button class="tab preview-tab" class:active={workspace.tab === PREVIEW_TAB} type="button" onclick={() => void switchTab(PREVIEW_TAB)}>
        System Prompt
      </button>
    </div>

    <div class="pane">
      {#if workspace.tab === PREVIEW_TAB}
        <PromptPreview />
      {:else}
        <FilePane />
      {/if}
    </div>
  </div>
</Modal>

<style>
  .wf { display: flex; flex-direction: column; gap: 12px; height: 100%; min-height: 0; }

  .tabs { display: flex; gap: 4px; flex-wrap: wrap; flex-shrink: 0; }
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: transparent;
    border: 1px solid var(--border);
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 13px;
    letter-spacing: 1px;
    text-transform: uppercase;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }
  .tab:hover { color: var(--text-secondary); border-color: var(--border-strong); }
  .tab.active { color: var(--accent); border-color: var(--accent-edge); border-bottom-color: var(--accent); background: var(--accent-faint); }
  .tab.missing { opacity: 0.5; }
  .preview-tab { margin-left: auto; }

  .badge {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    border: 1px solid var(--border);
    padding: 0 4px;
  }
  .tab.active .badge { color: var(--accent); border-color: var(--accent-edge); }

  .pane { flex: 1; min-height: 0; overflow-y: auto; }
</style>
