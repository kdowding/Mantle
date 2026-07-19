<!-- First-run onboarding — shown in the main stage when config has loaded but
     there's no active agent (a fresh clone, or every agent deleted). Guides the
     two steps to a working agent: connect a provider, then create one. App
     wires the CTAs (open Settings -> Providers, open Create Agent). -->
<script lang="ts">
  import { serverConfig } from '../lib/state.svelte';
  import { setUserName } from '../lib/api';
  import FeatureToggles from '../rooms/settings/FeatureToggles.svelte';

  let { onConnectProvider, onCreateAgent }: {
    onConnectProvider: () => void;
    onCreateAgent: () => void;
  } = $props();

  const ready = $derived(serverConfig.backends.filter((b) => b.configured).length);

  // Your name seeds {{user}} in the new agent's files — save it before creating
  // so the first agent is scaffolded already knowing what to call you.
  let userName = $state(serverConfig.user?.name ?? '');
  async function saveName(): Promise<void> {
    const n = userName.trim();
    if (!n || n === serverConfig.user?.name) return;
    try {
      await setUserName(n);
      serverConfig.user = { name: n };
    } catch { /* non-fatal — settable later in Settings → General */ }
  }
</script>

<div class="onb">
  <span class="corner tl" aria-hidden="true"></span>
  <span class="corner br" aria-hidden="true"></span>

  <div class="brand">rev://<span class="accent">MANTLE</span></div>
  <h1 class="title">Let's get you set up</h1>
  <p class="sub">A few quick steps to your first running agent.</p>

  <ol class="steps">
    <li class="step" class:done={ready > 0}>
      <span class="num">{ready > 0 ? '✓' : '1'}</span>
      <div class="body">
        <div class="s-title">Connect a provider</div>
        <p class="s-desc">Add an API key (Anthropic / OpenAI / xAI) or sign in to a subscription - your agents need a brain to think with.</p>
        {#if ready > 0}
          <div class="s-done">{ready} backend{ready === 1 ? '' : 's'} ready</div>
        {:else}
          <button class="cta" type="button" onclick={onConnectProvider}>Open Provider Settings →</button>
        {/if}
      </div>
    </li>

    <li class="step">
      <span class="num">2</span>
      <div class="body">
        <div class="s-title">Choose your features <span class="opt">optional</span></div>
        <p class="s-desc">Mantle starts lean — turn on only what you want. The heavy extras (voice, memory, local models) flag a one-time setup you can finish anytime.</p>
        <FeatureToggles />
      </div>
    </li>

    <li class="step" class:locked={ready === 0}>
      <span class="num">3</span>
      <div class="body">
        <div class="s-title">Name yourself & create your agent</div>
        <p class="s-desc">Tell your agent what to call you, then spin up a companion with its own identity, memory, and config — it opens straight into a fresh chat.</p>
        <label class="name-field">
          <span class="nf-label">Your name</span>
          <input class="nf-input" type="text" bind:value={userName} placeholder="e.g. Alex" onblur={saveName} onkeydown={(e) => { if (e.key === 'Enter') void saveName(); }} />
        </label>
        <button class="cta" class:primary={ready > 0} type="button" onclick={onCreateAgent} disabled={ready === 0}>Create Agent →</button>
        {#if ready === 0}
          <p class="s-hint">Connect a provider first — an agent with no backend can't reply.</p>
        {/if}
      </div>
    </li>
  </ol>
</div>

<style>
  .onb {
    position: relative;
    max-width: 560px;
    margin: auto;
    padding: 40px 44px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .corner { position: absolute; width: 26px; height: 26px; pointer-events: none; }
  .corner.tl { top: 0; left: 0; border-top: 1px solid var(--accent-edge); border-left: 1px solid var(--accent-edge); }
  .corner.br { right: 0; bottom: 0; border-right: 1px solid var(--accent-edge); border-bottom: 1px solid var(--accent-edge); }

  .brand {
    font-family: var(--font-display);
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .brand .accent { color: var(--accent); }
  .title {
    margin: 10px 0 4px;
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: 700;
    letter-spacing: 1px;
    color: var(--text-primary);
  }
  .sub { margin: 0 0 24px; font-size: 14px; color: var(--text-secondary); }

  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
    width: 100%;
    text-align: left;
  }
  .step {
    display: flex;
    gap: 14px;
    padding: 16px 18px;
    background: linear-gradient(180deg, var(--accent-faint), transparent 90px);
    border: 1px solid var(--border);
    border-left: 2px solid var(--border-strong);
  }
  .step.done { border-left-color: color-mix(in srgb, var(--success) 60%, transparent); }

  .num {
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    color: var(--accent);
    border: 1px solid var(--accent-edge);
    clip-path: polygon(5px 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%, 0 5px);
  }
  .step.done .num { color: var(--success); border-color: color-mix(in srgb, var(--success) 50%, transparent); }

  .body { min-width: 0; flex: 1; }
  .s-title { font-family: var(--font-display); font-size: 16px; font-weight: 600; letter-spacing: 0.5px; color: var(--text-primary); }
  .opt {
    margin-left: 8px;
    font-family: var(--font-display);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--text-muted);
    border: 1px solid var(--border-strong);
    padding: 1px 6px;
    vertical-align: middle;
  }
  .s-desc { margin: 4px 0 11px; font-size: 13px; line-height: 1.55; color: var(--text-muted); }
  .s-done { font-family: var(--font-mono); font-size: 13px; color: var(--success); }
  .s-hint { margin: 9px 0 0; font-size: 12px; color: var(--text-muted); font-style: italic; }

  .name-field { display: flex; flex-direction: column; gap: 5px; margin: 0 0 12px; }
  .nf-label { font-family: var(--font-display); font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: var(--text-muted); }
  .nf-input {
    max-width: 260px;
    padding: 8px 11px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 14px;
  }
  .nf-input:focus { outline: none; border-color: var(--accent); }
  .step.locked { opacity: 0.6; }

  .cta {
    background: transparent;
    border: 1px solid var(--accent);
    color: var(--accent);
    font-family: var(--font-display);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding: 8px 16px;
    cursor: pointer;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
    transition: background 0.15s, box-shadow 0.15s, color 0.15s;
  }
  .cta:hover { background: var(--accent-dim); box-shadow: 0 0 14px var(--accent-glow); }
  .cta:disabled {
    border-color: var(--border-strong);
    color: var(--text-muted);
    cursor: not-allowed;
    background: transparent;
    box-shadow: none;
    opacity: 0.7;
  }
  .cta.primary { background: var(--accent); border: none; color: var(--bg-primary); }
  .cta.primary:hover { box-shadow: 0 0 16px var(--accent-glow); }
</style>
