<!-- Settings modal — chat-effects toggle + the agents management list (rows
     open the agents room's edit modal; "+ New Agent" opens create). Port of
     app.js::buildSettingsModal / renderAgentSettingsList. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import Modal from '../../components/Modal.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { ui, serverConfig, avatarSrc } from '../../lib/state.svelte';
  import { backendById, displayModel } from '../../lib/inference';
  import { agentModals } from '../agents/agents.svelte';
  import { settings, setFx } from './settings.svelte';
  import ProvidersPanel from './ProvidersPanel.svelte';
  import FeaturesPanel from './FeaturesPanel.svelte';
  import ConnectionsPanel from './ConnectionsPanel.svelte';
  import type { Agent } from '../../lib/api';
  import { setUserName } from '../../lib/api';

  // Display-only summary of an agent's current model — the row "meta" line.
  // Resolution mirrors the in-chat picker: explicit override → backend
  // default → fall through to the vendor label alone.
  function summarizeInference(agent: Agent): string {
    const backend = agent.defaultProvider ? backendById(agent.defaultProvider) : undefined;
    const model = agent.defaultModel || backend?.defaultModel || null;
    const vendorLabel = backend ? (serverConfig.vendorLabels[backend.vendor] || backend.vendor) : 'default';
    return model ? `${vendorLabel} · ${displayModel(model)}` : vendorLabel;
  }

  function openAgent(id: string): void {
    settings.open = false; // the edit modal takes the stage
    agentModals.editId = id;
  }

  function newAgent(): void {
    settings.open = false;
    agentModals.create = true;
  }

  // The user's profile name (how agents address them). Seeds {{user}} on new
  // agents; persisted via PUT /api/config/user.
  let userName = $state(serverConfig.user?.name ?? '');
  let savingName = $state(false);
  let savedNameFlash = $state(false);
  let saveNameErr = $state(false);
  // This modal is ALWAYS mounted, so it read serverConfig.user BEFORE
  // /api/config loaded — the field came up blank. Re-seed from the loaded
  // config each time the modal opens (untracked so a config refresh mid-edit
  // can't clobber what you're typing).
  $effect(() => {
    if (settings.open) {
      saveNameErr = false;
      savedNameFlash = false;
      userName = untrack(() => serverConfig.user?.name ?? '');
    }
  });
  async function saveUserName(): Promise<void> {
    if (savingName) return;
    savingName = true;
    saveNameErr = false;
    try {
      const r = await setUserName(userName.trim());
      userName = r.name;
      serverConfig.user = { name: r.name };
      savedNameFlash = true;
      setTimeout(() => (savedNameFlash = false), 1600);
    } catch {
      saveNameErr = true; // surface it instead of silently keeping the text
    } finally {
      savingName = false;
    }
  }
</script>

<Modal bind:open={settings.open} title="Settings" size="md">
  <div class="tabs">
    <button class="tab" class:active={settings.tab === 'general'} type="button" onclick={() => (settings.tab = 'general')}>General</button>
    <button class="tab" class:active={settings.tab === 'providers'} type="button" onclick={() => (settings.tab = 'providers')}>Providers</button>
    <button class="tab" class:active={settings.tab === 'features'} type="button" onclick={() => (settings.tab = 'features')}>Features</button>
    <button class="tab" class:active={settings.tab === 'connections'} type="button" onclick={() => (settings.tab = 'connections')}>Connections</button>
  </div>

  {#if settings.tab === 'general'}
  <div class="settings-section">
    <div class="settings-section-title">You</div>
    <div class="settings-section-desc">
      The name your agents call you - applied when a new agent is created.
    </div>
    <div class="profile-name-row">
      <input
        class="profile-name-input"
        type="text"
        placeholder="e.g. Alex"
        bind:value={userName}
        onkeydown={(e) => { if (e.key === 'Enter') void saveUserName(); }}
      />
      <button
        class="settings-action-btn"
        class:flash={savedNameFlash}
        type="button"
        onclick={() => void saveUserName()}
        disabled={savingName}
      >
        {savingName ? 'Saving…' : savedNameFlash ? 'Saved ✓' : saveNameErr ? 'Retry' : 'Save'}
      </button>
    </div>
    {#if saveNameErr}<div class="profile-name-err">Couldn't save - check the connection and try again.</div>{/if}
  </div>
  <div class="settings-section">
    <div class="settings-section-title">Chat Effects</div>
    <div class="settings-section-desc">
      Animated background - matrix character rain plus ambient agent typewriter panels.
      Heavy by design (canvas at ~60fps); off by default.
    </div>
    <div class="settings-toggle-row">
      <Toggle checked={settings.fx} onchange={setFx} label="Enable chat effects" />
      <span class="settings-toggle-label">Enable chat effects</span>
    </div>
  </div>
  <div class="settings-section">
    <div class="settings-section-title-row">
      <div>
        <div class="settings-section-title">Agents</div>
        <div class="settings-section-desc">
          Manage your agents - click an agent to edit its identity, default model,
          and memory store.
        </div>
      </div>
      <button class="settings-action-btn" type="button" onclick={newAgent}>+ New Agent</button>
    </div>
    <div class="agent-settings-list">
      {#each ui.agents as agent (agent.id)}
        <button
          class="agent-settings-row"
          type="button"
          style:--row-accent={agent.accentColor || null}
          onclick={() => openAgent(agent.id)}
        >
          <div class="as-avatar">
            {#if agent.hasAvatar}
              <img src={avatarSrc(agent.id)} alt="" />
            {:else}
              {(agent.name || agent.id || '?').charAt(0).toUpperCase()}
            {/if}
          </div>
          <div class="as-info">
            <div class="as-name">{agent.name}</div>
            <div class="as-meta">{summarizeInference(agent)} · memory: {agent.englyphPath || 'isolated'}</div>
          </div>
          <span class="as-arrow">&rsaquo;</span>
        </button>
      {/each}
    </div>
  </div>
  {:else if settings.tab === 'providers'}
    <ProvidersPanel />
  {:else if settings.tab === 'features'}
    <FeaturesPanel />
  {:else if settings.tab === 'connections'}
    <ConnectionsPanel />
  {/if}
</Modal>

<style>
  .tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .tab {
    padding: 7px 14px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .tab:hover { color: var(--text-secondary); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }

  /* Carried from ui/styles-modal.css (.settings-* / .agent-settings-*). */
  .settings-section { margin-bottom: 20px; }
  .profile-name-row { display: flex; gap: 8px; align-items: center; }
  .profile-name-input {
    flex: 1;
    padding: 7px 10px;
    background: transparent;
    border: 1px solid var(--border);
    color: inherit;
    font: inherit;
    border-radius: 4px;
  }
  .profile-name-input:focus { outline: none; border-color: var(--accent); }
  .settings-section-title {
    font-family: var(--font-display);
    font-size: 14px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--accent);
    margin-bottom: 4px;
  }
  .settings-section-desc { font-size: 12px; color: var(--text-muted); margin-bottom: 12px; }
  .settings-section-title-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }

  .settings-toggle-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    margin-top: 8px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .settings-toggle-row:hover { border-color: var(--accent-glow); background: var(--accent-faint); }
  .settings-toggle-label { font-size: 13px; color: var(--text-primary); }

  .settings-action-btn {
    background: transparent;
    border: 1px solid var(--accent);
    color: var(--accent);
    padding: 6px 12px;
    font-family: var(--font-display);
    font-size: 12px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 1px;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .settings-action-btn:hover { background: var(--accent-dim); }
  .settings-action-btn.flash { background: var(--accent); color: var(--bg-primary); border-color: var(--accent); }
  .profile-name-err { margin-top: 6px; font-size: 12px; color: var(--error); }

  .agent-settings-list { display: flex; flex-direction: column; gap: 8px; }
  .agent-settings-row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 10px 12px;
    text-align: left;
    font: inherit;
    color: inherit;
    background: var(--bg-panel, var(--bg-tertiary));
    border: 1px solid var(--border);
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .agent-settings-row:hover { border-color: var(--row-accent, var(--accent)); background: var(--accent-faint); }
  .as-avatar {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    font-family: var(--font-display);
    font-weight: 600;
    color: var(--row-accent, var(--accent));
    background: var(--bg-tertiary);
    border: 1px solid var(--row-accent, var(--accent));
    clip-path: polygon(10% 0, 100% 0, 100% 90%, 90% 100%, 0 100%, 0 10%);
  }
  .as-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .as-info { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .as-name {
    font-family: var(--font-display);
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .as-meta {
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .as-arrow { color: var(--text-muted); font-size: 16px; flex-shrink: 0; }
</style>
