<script lang="ts">
  // Edit-agent modal: identity (name/accent/avatar), default inference,
  // englyph path. Pre-fetches GET /api/agents/:id so fields aren't
  // stale. Delete opens the dedicated footprint modal (stacked above).
  import Modal from '../../components/Modal.svelte';
  import Button from '../../components/Button.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { getAgent, updateAgent, uploadAgentAvatar, avatarUrl, type AgentDetail } from '../../lib/api';
  import { ui, getFeature } from '../../lib/state.svelte';
  import { loadAgents, refreshActiveProfile, markAvatarUploaded } from '../../lib/agents';
  import { applyAccent } from '../../lib/theme';
  import { agentModals, detectSharedEnglyphPath, resolveEnglyphPath, type EnglyphMode } from './agents.svelte';
  import ProviderModelSelect from '../../components/ProviderModelSelect.svelte';
  import EnglyphModePicker from './EnglyphModePicker.svelte';

  let { agentId }: { agentId: string } = $props();

  let agent = $state<AgentDetail | null>(null);
  let loadError = $state('');

  // Fields — populated when the fetch lands.
  let name = $state('');
  let accent = $state('#00d4aa');
  let provider = $state('');
  let model = $state('');
  let sharePath = $state<string | null>(null);
  let englyphMode = $state<EnglyphMode>('isolated');
  let englyphCustom = $state('');

  let avatarBust = $state(0); // bump to cache-bust the preview
  // Seed from the roster's hasAvatar so an avatar-less agent renders the
  // letter tile directly instead of firing a guaranteed-404 image request.
  let avatarFailed = $state(!ui.agents.find((a) => a.id === agentId)?.hasAvatar);
  let avatarStatus = $state('');
  let avatarInput = $state<HTMLInputElement>(); // bound inside the loaded branch

  let error = $state('');
  let saving = $state(false);

  // Deck-assist autonomy (per-action auto-approve), persisted via its own
  // endpoint (immediate, like skill/tool toggles) — not part of save().
  let autoApprove = $state<string[]>([]);
  const AUTO_APPROVE_KEYS = [
    { key: 'cron.create', label: 'Create cron jobs' },
    { key: 'cron.update', label: 'Update / enable / disable cron jobs' },
    { key: 'cron.delete', label: 'Delete cron jobs' },
    { key: 'skill.delete', label: 'Delete skills' },
    { key: 'skill.enable', label: 'Enable skills' },
    { key: 'skill.disable', label: 'Disable skills' },
  ];

  $effect(() => {
    void load();
  });

  async function toggleAuto(key: string, allowed: boolean): Promise<void> {
    autoApprove = allowed ? [...new Set([...autoApprove, key])] : autoApprove.filter((k) => k !== key);
    try {
      await fetch(`/api/agents/${encodeURIComponent(agentId)}/assist/auto-approve`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, allowed }),
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function load(): Promise<void> {
    try {
      const a = await getAgent(agentId);
      agent = a;
      name = a.name ?? '';
      accent = a.accentColor ?? '#00d4aa';
      provider = a.defaultProvider ?? '';
      model = a.defaultModel ?? '';
      // Prefer the path other agents share; fall back to this agent's own.
      const candidate = detectSharedEnglyphPath() ?? a.englyphPath ?? null;
      sharePath = candidate;
      englyphMode = !a.englyphPath ? 'isolated' : a.englyphPath === candidate ? 'share' : 'custom';
      englyphCustom = englyphMode === 'custom' ? (a.englyphPath ?? '') : '';
      try {
        const ar = await fetch(`/api/agents/${encodeURIComponent(agentId)}/assist/auto-approve`);
        if (ar.ok) autoApprove = ((await ar.json()) as { autoApprove?: string[] }).autoApprove ?? [];
      } catch { /* best-effort */ }
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  }

  function close(): void {
    agentModals.editId = null;
  }

  async function save(): Promise<void> {
    if (!agent) return;
    // Props are LIVE: close() nulls agentModals.editId, which feeds this
    // component's `agentId` — capture it before any code that runs post-close.
    const id = agentId;
    error = '';
    if (!name.trim()) { error = 'Name is required.'; return; }
    const englyph = resolveEnglyphPath(englyphMode, englyphCustom, sharePath, true);
    if (!englyph.ok) { error = englyph.error; return; }

    saving = true;
    try {
      const data = await updateAgent(id, {
        name: name.trim(),
        accentColor: accent,
        defaultProvider: provider || null,
        defaultModel: model || null,
        // With the memory feature off the picker never rendered — omit the
        // path entirely so a stored value can't be clobbered blind.
        ...(getFeature('memory')?.enabled ? { englyphPath: englyph.value } : {}),
      });
      close();
      await loadAgents();
      if (ui.currentAgentId === id) {
        applyAccent(data.agent?.accentColor ?? null);
        void refreshActiveProfile();
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  async function onAvatarPicked(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // same file re-pick still fires change
    if (!file) return;
    avatarStatus = 'Uploading…';
    try {
      await uploadAgentAvatar(agentId, file);
      avatarStatus = 'Uploaded.';
      avatarFailed = false;
      avatarBust++; // refresh this modal's own preview (local Date.now buster)
      // Reflect the new avatar across the whole app (sidebar/settings/roster +
      // profile bar / lobby / message chips) without a page reload.
      markAvatarUploaded(agentId);
    } catch (err) {
      avatarStatus = `Upload failed: ${err instanceof Error ? err.message : err}`;
    }
  }
</script>

<Modal open title="Edit Agent" size="md" onclose={close}>
  {#if loadError}
    <div class="error">Failed to load agent: {loadError}</div>
  {:else if !agent}
    <div class="muted">Loading…</div>
  {:else}
    <div class="form">
      <div class="row avatar-row">
        <div class="avatar-box">
          {#key avatarBust}
            {#if !avatarFailed}
              <img src={avatarUrl(agentId, true)} alt="" onerror={() => (avatarFailed = true)} />
            {:else}
              <span class="avatar-fallback">{(name || '?').charAt(0).toUpperCase()}</span>
            {/if}
          {/key}
        </div>
        <div class="avatar-controls">
          <Button variant="ghost" onclick={() => avatarInput?.click()}>Change avatar</Button>
          <input bind:this={avatarInput} type="file" accept="image/*" hidden onchange={onAvatarPicked} />
          {#if avatarStatus}<span class="avatar-status">{avatarStatus}</span>{/if}
        </div>
      </div>

      <div class="row">
        <label class="field">
          <span>Name</span>
          <input type="text" bind:value={name} />
        </label>
        <label class="field accent-field">
          <span>Accent</span>
          <input type="color" bind:value={accent} />
        </label>
      </div>

      <div class="section">Default Inference</div>
      <ProviderModelSelect bind:provider bind:model />

      {#if getFeature('memory')?.enabled}
        <EnglyphModePicker bind:mode={englyphMode} bind:customPath={englyphCustom} {sharePath} />
      {/if}

      <div class="section">Assist autonomy</div>
      <div class="auto-hint">Structured actions the deck assist may run for this agent WITHOUT a confirm card. File-content edits always stay accept/reject.</div>
      {#each AUTO_APPROVE_KEYS as a (a.key)}
        <div class="auto-row">
          <Toggle checked={autoApprove.includes(a.key)} label={a.label} onchange={(v) => void toggleAuto(a.key, v)} />
          <span class="auto-label">{a.label}</span>
          <code class="auto-key">{a.key}</code>
        </div>
      {/each}

      {#if error}<div class="error">{error}</div>{/if}
    </div>
  {/if}

  {#snippet footer()}
    <Button variant="danger" onclick={() => (agentModals.deleteId = agentId)}>Delete…</Button>
    <span class="spacer"></span>
    <Button variant="ghost" onclick={close}>Cancel</Button>
    <Button variant="primary" onclick={() => void save()} disabled={saving || !agent}>
      {saving ? 'Saving…' : 'Save'}
    </Button>
  {/snippet}
</Modal>

<style>
  /* Form styling comes from the global form kit (src/form.css); only what's
     unique to this modal lives here. */
  .muted { color: var(--text-muted); font-size: 14px; }
  .accent-field { flex: 0 0 90px; }

  .avatar-row { align-items: center; }
  .avatar-box {
    width: 64px;
    height: 64px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    border: 1.5px solid var(--accent);
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
    background: var(--accent-faint);
    overflow: hidden;
  }
  .avatar-box img { width: 100%; height: 100%; object-fit: cover; }
  .avatar-fallback {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 26px;
    color: var(--accent);
  }
  .avatar-controls { display: flex; flex-direction: column; gap: 5px; align-items: flex-start; }
  .avatar-status { font-size: 12px; color: var(--text-muted); }

  .spacer { flex: 1; }
  .error { color: var(--error); font-size: 13px; }

  .auto-hint { font-size: 12px; color: var(--text-muted); line-height: 1.5; margin: -2px 0 6px; }
  .auto-row { display: flex; align-items: center; gap: 10px; padding: 4px 0; }
  .auto-label { font-size: 14px; color: var(--text-secondary); flex: 1; }
  .auto-key { font-family: var(--font-mono); font-size: 12px; color: var(--text-muted); }
</style>
