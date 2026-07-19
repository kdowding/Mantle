<script lang="ts">
  // Create-agent modal. On success: reload the roster and switch to the new
  // agent (boot scaffolds its workspace server-side).
  import { untrack } from 'svelte';
  import Modal from '../../components/Modal.svelte';
  import Button from '../../components/Button.svelte';
  import { createAgent } from '../../lib/api';
  import { loadAgents, selectAgent } from '../../lib/agents';
  import { getFeature } from '../../lib/state.svelte';
  import { agentModals, detectSharedEnglyphPath, resolveEnglyphPath, type EnglyphMode } from './agents.svelte';
  import ProviderModelSelect from '../../components/ProviderModelSelect.svelte';
  import EnglyphModePicker from './EnglyphModePicker.svelte';

  let name = $state('');
  let id = $state('');
  let tagline = $state('');
  let accent = $state('#00d4aa');
  let provider = $state('');
  let model = $state('');

  // Seeded once per open (the host remounts this component) — untrack states it.
  const sharePath = untrack(() => detectSharedEnglyphPath());
  let englyphMode = $state<EnglyphMode>(sharePath ? 'share' : 'isolated');
  let englyphCustom = $state('');

  let error = $state('');
  let saving = $state(false);

  function close(): void {
    agentModals.create = false;
  }

  async function save(): Promise<void> {
    error = '';
    if (!name.trim()) { error = 'Name is required.'; return; }
    const englyph = resolveEnglyphPath(englyphMode, englyphCustom, sharePath, false);
    if (!englyph.ok) { error = englyph.error; return; }

    saving = true;
    try {
      const data = await createAgent({
        name: name.trim(),
        id: id.trim() || undefined,
        tagline: tagline.trim() || undefined,
        accentColor: accent,
        defaultProvider: provider || undefined,
        defaultModel: model || undefined,
        englyphPath: englyph.value,
      });
      close();
      await loadAgents();
      if (data.agent?.id) void selectAgent(data.agent.id);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }
</script>

<Modal open title="Create Agent" size="md" onclose={close}>
  <div class="form">
    <div class="row">
      <label class="field">
        <span>Name</span>
        <input type="text" bind:value={name} placeholder="e.g. Nova" />
      </label>
    </div>
    <div class="row">
      <label class="field">
        <span>ID (optional)</span>
        <input type="text" bind:value={id} placeholder="derived from name" />
      </label>
      <label class="field accent-field">
        <span>Accent</span>
        <input type="color" bind:value={accent} />
      </label>
    </div>
    <label class="field">
      <span>Tagline</span>
      <input type="text" bind:value={tagline} placeholder="Optional one-liner" />
    </label>

    <div class="section">Default Inference</div>
    <ProviderModelSelect bind:provider bind:model />

    {#if getFeature('memory')?.enabled}
      <EnglyphModePicker bind:mode={englyphMode} bind:customPath={englyphCustom} {sharePath} />
    {/if}

    {#if error}<div class="error">{error}</div>{/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={close}>Cancel</Button>
    <Button variant="primary" onclick={() => void save()} disabled={saving}>
      {saving ? 'Creating…' : 'Create Agent'}
    </Button>
  {/snippet}
</Modal>

<style>
  /* Form styling comes from the global form kit (src/form.css); only what's
     unique to this modal lives here. */
  .accent-field { flex: 0 0 90px; }
</style>
