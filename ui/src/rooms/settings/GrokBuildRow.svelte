<!-- Grok Build (xAI subscription) auth status. Unlike Codex there's no in-app
     login flow — Grok Build reuses the Grok CLI's session (~/.grok/auth.json),
     which mantle picks up. So this just reports connected/not (read from the
     xai/subscription backend's `configured` flag) + a Recheck that re-pulls
     /api/config, plus how to authenticate. -->
<script lang="ts">
  import { serverConfig } from '../../lib/state.svelte';
  import { getConfig } from '../../lib/api';
  import { loadServerConfig } from '../../lib/inference';

  let busy = $state(false);
  const connected = $derived(!!serverConfig.backends.find((b) => b.id === 'xai/subscription')?.configured);

  async function recheck(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      loadServerConfig(await getConfig());
    } catch {
      /* leave prior state on a failed refresh */
    } finally {
      busy = false;
    }
  }
</script>

<div class="gb-row">
  <span class="gb-status" class:on={connected}>{connected ? '✓ Connected' : 'Not connected'}</span>
  <button class="gb-btn" type="button" disabled={busy} onclick={recheck}>{busy ? 'Checking…' : 'Recheck'}</button>
</div>
{#if !connected}
  <p class="gb-hint">
    No in-app sign-in - Grok Build reuses the Grok CLI's session. Run <code>grok</code> in a terminal and
    log in; mantle reads the token from <code>~/.grok/auth.json</code>. Then hit Recheck.
  </p>
{/if}

<style>
  .gb-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 11px;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    font-family: var(--font-display);
    font-size: 12.5px;
    letter-spacing: 0.6px;
  }
  .gb-status { flex: 1; min-width: 0; color: var(--accent-pink, #ff2d7c); }
  .gb-status.on { color: var(--accent); }
  .gb-btn {
    flex-shrink: 0;
    background: var(--bg-panel, var(--bg-tertiary));
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    font-family: var(--font-display);
    font-size: 11px;
    letter-spacing: 1px;
    text-transform: uppercase;
    font-weight: 600;
    padding: 5px 12px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .gb-btn:hover:not(:disabled) { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
  .gb-btn:disabled { opacity: 0.5; cursor: default; }

  .gb-hint { margin: 8px 0 0; font-size: 12.5px; line-height: 1.55; color: var(--text-muted); }
  .gb-hint code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-secondary);
    background: var(--accent-faint);
    padding: 1px 4px;
    border: 1px solid var(--border);
  }
</style>
