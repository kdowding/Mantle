<script lang="ts">
  // Two-stage agent destruction: footprint manifest first (workspace,
  // sessions, cron jobs, the always-kept Englyph store),
  // then a type-the-id-verbatim gate. The server validates the confirm
  // token independently, so this gate is UX, not the security boundary.
  import Modal from '../../components/Modal.svelte';
  import Button from '../../components/Button.svelte';
  import { getAgentFootprint, deleteAgent, type AgentFootprint } from '../../lib/api';
  import { ui } from '../../lib/state.svelte';
  import { loadAgents, selectAgent, clearActiveAgent } from '../../lib/agents';
  import { agentModals } from './agents.svelte';

  let { agentId }: { agentId: string } = $props();

  let footprint = $state<AgentFootprint | null>(null);
  let footprintError = $state('');
  let confirmText = $state('');
  let error = $state('');
  let deleting = $state(false);
  let cleanupWarning = $state('');

  const match = $derived(confirmText.trim() === agentId);

  $effect(() => {
    getAgentFootprint(agentId)
      .then((f) => (footprint = f))
      .catch((e: unknown) => (footprintError = e instanceof Error ? e.message : String(e)));
  });

  interface Row { warn?: boolean; kept?: boolean; icon: string; label: string; detail?: string; note?: string }

  const rows = $derived.by<Row[]>(() => {
    const f = footprint;
    if (!f) return [];
    const out: Row[] = [];
    const fileCount = (n?: number): string => (n === 1000 ? '1000+' : String(n ?? 0));

    if (f.workspace?.inProject) {
      out.push({
        icon: '✕',
        label: 'Workspace folder',
        detail: f.workspace.path,
        note: f.workspace.exists
          ? `${fileCount(f.workspace.fileCount)} file(s) - AGENTS / IDENTITY / SOUL / USER / MEMORY, personas, avatar, any per-agent skills`
          : 'already missing - nothing to remove',
      });
    } else if (f.workspace) {
      out.push({
        warn: true,
        icon: '!',
        label: 'Workspace folder (will be skipped)',
        detail: f.workspace.path,
        note: 'Outside the project tree - refusing to delete. Clean up by hand if intended.',
      });
    }

    if (f.sessions?.inProject) {
      out.push({
        icon: '✕',
        label: 'Session transcripts',
        detail: f.sessions.path,
        note: f.sessions.exists ? `${fileCount(f.sessions.fileCount)} file(s) - JSONL transcripts + index.json` : 'already missing',
      });
    }

    if ((f.cron?.jobCount ?? 0) > 0) {
      out.push({ icon: '✕', label: `Cron jobs (${f.cron?.jobCount})`, detail: (f.cron?.jobNames ?? []).join(', ') });
    }

    out.push({
      kept: true,
      icon: '✓',
      label: 'Englyph memory store',
      detail: f.englyph?.path ?? '-',
      note: f.englyph?.shared
        ? `Kept. Shared with: ${(f.englyph.sharedWith ?? []).join(', ') || 'other agents'}`
        : 'Kept. Adapter will be stopped; data files left intact.',
    });

    if (f.isDefault) {
      out.push({ warn: true, icon: '!', label: 'Default agent', note: 'This is the workspace default - another agent will take over after deletion.' });
    }
    return out;
  });

  function close(): void {
    agentModals.deleteId = null;
  }

  async function confirmDelete(): Promise<void> {
    if (!match || deleting) return;
    error = '';
    deleting = true;
    try {
      const data = await deleteAgent(agentId);

      // Surface partial-failure cleanup steps — the config entry is gone, but
      // the user may need to finish by hand.
      const failed = (data.cleanup ?? []).filter((s) => !s.ok);
      if (failed.length > 0) {
        cleanupWarning = failed.map((s) => `${s.step}: ${s.detail ?? 'unknown'}`).join('\n');
      }

      const deletedActive = ui.currentAgentId === agentId;
      agentModals.deleteId = null;
      agentModals.editId = null;
      await loadAgents();
      if (deletedActive) {
        const next = data.defaultAgent ?? null;
        if (next) void selectAgent(next);
        else clearActiveAgent();
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      deleting = false;
    }
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && match) {
      e.preventDefault();
      void confirmDelete();
    }
  }
</script>

<Modal open title="Delete Agent" size="md" closeOnBackdrop={false} onclose={close}>
  <div class="body">
    <p class="lede">
      This permanently removes <strong>{footprint?.agent?.name ?? agentId}</strong> and the data below.
      The Englyph memory store is never deleted.
    </p>

    <div class="manifest">
      {#if footprintError}
        <div class="manifest-error">Failed to load footprint: {footprintError}</div>
      {:else if !footprint}
        <div class="manifest-loading">Calculating footprint…</div>
      {:else}
        {#each rows as r, i (i)}
          <div class="mrow" class:warn={r.warn} class:kept={r.kept}>
            <span class="micon">{r.icon}</span>
            <div class="mbody">
              <div class="mlabel">{r.label}</div>
              {#if r.detail}<div class="mdetail">{r.detail}</div>{/if}
              {#if r.note}<div class="mnote">{r.note}</div>{/if}
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <label class="confirm">
      <span>Type <code>{agentId}</code> to confirm</span>
      <input type="text" bind:value={confirmText} class:is-match={match} onkeydown={onKey} placeholder={agentId} />
    </label>

    {#if cleanupWarning}
      <div class="warn-box">Agent removed, but some cleanup steps failed:
{cleanupWarning}
Clean up manually if needed.</div>
    {/if}
    {#if error}<div class="error">{error}</div>{/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={close}>Cancel</Button>
    <Button variant="danger" onclick={() => void confirmDelete()} disabled={!match || deleting}>
      {deleting ? 'Deleting…' : 'Delete'}
    </Button>
  {/snippet}
</Modal>

<style>
  .body { display: flex; flex-direction: column; gap: 12px; }
  .lede { margin: 0; font-size: 14px; color: var(--text-secondary); line-height: 1.5; }
  .lede strong { color: var(--text-primary); }

  .manifest { display: flex; flex-direction: column; gap: 7px; }
  .manifest-loading, .manifest-error { font-size: 13px; color: var(--text-muted); }
  .manifest-error { color: var(--error); }

  .mrow {
    display: flex;
    gap: 9px;
    padding: 7px 9px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-left: 2px solid var(--error);
  }
  .mrow.kept { border-left-color: var(--accent); }
  .mrow.warn { border-left-color: var(--accent-reason, #ffb84d); }
  .micon { font-size: 13px; color: var(--error); flex-shrink: 0; margin-top: 1px; }
  .mrow.kept .micon { color: var(--accent); }
  .mrow.warn .micon { color: var(--accent-reason, #ffb84d); }
  .mbody { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .mlabel { font-family: var(--font-display); font-size: 12px; letter-spacing: 0.5px; }
  .mdetail { font-family: var(--font-mono); font-size: 12px; color: var(--text-muted); word-break: break-all; }
  .mnote { font-size: 12px; color: var(--text-secondary); }

  .confirm { display: flex; flex-direction: column; gap: 4px; }
  .confirm > span { font-size: 13px; color: var(--text-secondary); }
  .confirm code { font-family: var(--font-mono); color: var(--error); }
  .confirm input {
    padding: 7px 10px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 14px;
  }
  .confirm input:focus { outline: none; border-color: var(--error); }
  .confirm input.is-match { border-color: var(--accent); }

  .warn-box {
    padding: 8px 10px;
    border: 1px solid var(--accent-reason, #ffb84d);
    color: var(--accent-reason, #ffb84d);
    font-size: 12px;
    white-space: pre-wrap;
  }
  .error { color: var(--error); font-size: 13px; }
</style>
