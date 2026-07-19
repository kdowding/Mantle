<!-- Providers settings tab: API-key entry for Anthropic / OpenAI / xAI plus the
     subscription auth rows (ChatGPT-Codex login flow + Grok-Build status). The
     key write side lives in M3's PUT /api/config/providers. -->
<script lang="ts">
  import ProviderKeyRow from './ProviderKeyRow.svelte';
  import CodexAuthRow from '../codex/CodexAuthRow.svelte';
  import GrokBuildRow from './GrokBuildRow.svelte';
  import type { KeyVendor } from '../../lib/api';

  const VENDORS: { vendor: KeyVendor; label: string; envVar: string; placeholder: string }[] = [
    { vendor: 'claude', label: 'Anthropic · Claude', envVar: 'ANTHROPIC_API_KEY', placeholder: 'sk-ant-…' },
    { vendor: 'openai', label: 'OpenAI · ChatGPT', envVar: 'OPENAI_API_KEY', placeholder: 'sk-…' },
    { vendor: 'grok', label: 'xAI · Grok', envVar: 'XAI_API_KEY', placeholder: 'xai-…' },
  ];
</script>

<div class="providers">
  <p class="lede">
    Keys are stored locally in <code>.mantle/config.json</code> and only ever leave this machine to talk
    to the provider. Set one here or via an environment variable - a key set here wins.
  </p>

  <section class="group">
    <h3 class="group-label">API keys</h3>
    <div class="cards">
      {#each VENDORS as v (v.vendor)}
        <ProviderKeyRow vendor={v.vendor} label={v.label} envVar={v.envVar} placeholder={v.placeholder} />
      {/each}
    </div>
  </section>

  <section class="group">
    <h3 class="group-label">Music</h3>
    <div class="cards">
      <ProviderKeyRow
        vendor="music"
        label="kie.ai · Music"
        envVar="KIE_API_KEY"
        placeholder="kie.ai API key"
        hint="Generate songs through your agents. The player works without it — upload your own tracks; only AI generation needs a key." />
    </div>
  </section>

  <section class="group">
    <h3 class="group-label">Subscriptions</h3>
    <div class="subs">
      <div class="sub">
        <div class="sub-label">ChatGPT · Codex</div>
        <CodexAuthRow />
      </div>
      <div class="sub">
        <div class="sub-label">Grok Build · xAI</div>
        <GrokBuildRow />
      </div>
    </div>
  </section>
</div>

<style>
  .providers { display: flex; flex-direction: column; gap: 22px; }
  .lede { margin: 0; font-size: 13.5px; line-height: 1.6; color: var(--text-secondary); }
  .lede code {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-primary);
    background: var(--accent-faint);
    padding: 1px 5px;
    border: 1px solid var(--border);
  }

  .group { display: flex; flex-direction: column; gap: 12px; }
  .group-label {
    margin: 0;
    font-family: var(--font-display);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--accent);
    border-bottom: 1px solid var(--border-strong);
    padding-bottom: 6px;
  }

  .cards { display: flex; flex-direction: column; gap: 10px; }
  .subs { display: flex; flex-direction: column; gap: 16px; }
  .sub { display: flex; flex-direction: column; gap: 8px; }
  .sub-label { font-family: var(--font-display); font-size: 15px; font-weight: 600; letter-spacing: 0.5px; color: var(--text-primary); }
</style>
