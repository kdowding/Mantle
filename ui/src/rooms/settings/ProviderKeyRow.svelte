<!-- One provider's API-key control: a framed card with a source pill (set /
     via env / not set), a masked entry, Save (with the validation probe
     result) and Clear. Reads presence+source from serverConfig.providerKeys;
     never sees the key value. -->
<script lang="ts">
  import { serverConfig } from '../../lib/state.svelte';
  import { setProviderKey, type KeyVendor } from '../../lib/api';
  import { loadConnections } from '../../lib/agents';

  let { vendor, label, envVar, placeholder, hint }: {
    vendor: KeyVendor;
    label: string;
    envVar: string;
    placeholder: string;
    hint?: string;
  } = $props();

  let value = $state('');
  let busy = $state(false);
  let result = $state<{ ok: boolean; error?: string } | null>(null);

  const keyState = $derived(serverConfig.providerKeys?.[vendor] ?? { set: false, source: 'none' as const });

  async function commit(key: string): Promise<void> {
    if (busy) return;
    busy = true;
    result = null;
    try {
      const res = await setProviderKey(vendor, key);
      serverConfig.providerKeys = { ...serverConfig.providerKeys, [vendor]: { set: res.set, source: res.source } };
      result = res.validation;
      value = ''; // never retain the key in the field
      void loadConnections().catch(() => {}); // refresh feature gates (xaiTts / realtime / music)
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

  const save = (): void => { if (value.trim()) void commit(value.trim()); };
  const clear = (): void => void commit('');
</script>

<div class="row">
  <div class="head">
    <span class="label">{label}</span>
    {#if keyState.set && keyState.source === 'config'}
      <span class="pill ok">✓ set</span>
    {:else if keyState.set && keyState.source === 'env'}
      <span class="pill env" title="Provided by the {envVar} environment variable - type a key to override it.">via env</span>
    {:else}
      <span class="pill none">not set</span>
    {/if}
  </div>

  {#if hint}<p class="hint">{hint}</p>{/if}

  <div class="entry">
    <input
      type="password"
      autocomplete="off"
      spellcheck="false"
      placeholder={keyState.source === 'env' ? `using ${envVar} - type to override` : placeholder}
      bind:value
      disabled={busy}
      onkeydown={(e) => { if (e.key === 'Enter') save(); }}
    />
    <button class="btn save" type="button" disabled={busy || !value.trim()} onclick={save}>Save</button>
    {#if keyState.set && keyState.source === 'config'}
      <button class="btn clear" type="button" disabled={busy} onclick={clear}>Clear</button>
    {/if}
  </div>

  {#if result}
    <div class="result" class:ok={result.ok} class:bad={!result.ok}>
      {result.ok ? '✓ verified - the key works' : `✗ ${result.error ?? 'verification failed'}`}
    </div>
  {/if}
</div>

<style>
  .row {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 13px 15px;
    background: linear-gradient(180deg, var(--accent-faint), transparent 70px);
    border: 1px solid var(--border);
    border-left: 2px solid var(--border-strong);
    transition: border-color 0.15s, border-left-color 0.15s;
  }
  .row:hover { border-left-color: var(--accent); }

  .head { display: flex; align-items: center; justify-content: space-between; gap: 9px; }
  .hint { margin: -2px 0 0; font-size: 12px; line-height: 1.45; color: var(--text-muted); }
  .label { font-family: var(--font-display); font-size: 15px; font-weight: 600; letter-spacing: 0.5px; color: var(--text-primary); }
  .pill {
    flex-shrink: 0;
    font-family: var(--font-display);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding: 2px 8px;
    border: 1px solid var(--border-strong);
  }
  .pill.ok { color: var(--success); border-color: color-mix(in srgb, var(--success) 50%, transparent); }
  .pill.env { color: var(--accent-reason, #ffb84d); border-color: color-mix(in srgb, var(--accent-reason, #ffb84d) 45%, transparent); }
  .pill.none { color: var(--text-muted); }

  .entry { display: flex; gap: 8px; }
  .entry input {
    flex: 1;
    min-width: 0;
    padding: 8px 11px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 14px;
  }
  .entry input:focus { outline: none; border-color: var(--accent); }

  .btn {
    flex-shrink: 0;
    padding: 7px 16px;
    font-family: var(--font-display);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    cursor: pointer;
    transition: box-shadow 0.15s, opacity 0.15s, background 0.15s, border-color 0.15s, color 0.15s;
  }
  .btn.save { background: var(--accent); border: none; color: var(--bg-primary); }
  .btn.save:hover:not(:disabled) { box-shadow: 0 0 12px var(--accent-glow); }
  .btn.clear { background: transparent; border: 1px solid var(--border-strong); color: var(--text-muted); }
  .btn.clear:hover:not(:disabled) { border-color: var(--error); color: var(--error); }
  .btn:disabled { opacity: 0.4; cursor: default; }

  .result { font-size: 13px; font-family: var(--font-mono); line-height: 1.45; }
  .result.ok { color: var(--success); }
  .result.bad { color: var(--error); }
</style>
