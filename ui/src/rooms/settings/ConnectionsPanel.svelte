<!-- Connections tab: a live "is my setup working" view. Pulls the aggregate
     /api/connections snapshot and renders a status row per subsystem
     (inference / memory / voice / local) with a colored dot + rail. Inference
     is the only required one; the rest are optional and read 'disabled' (warn)
     when off. -->
<script lang="ts">
  import { connections } from '../../lib/state.svelte';
  import { loadConnections } from '../../lib/agents';

  // Reads the shared connections snapshot (the same fetch the feature gates'
  // readiness comes from), but renders the richer per-subsystem detail from the
  // raw fields below — backend list / daemon URL / model counts — rather than the
  // features[] rows. Verdicts track the readiness model; if you change one,
  // re-check the other. Local busy/error drive the Recheck UX.
  const data = $derived(connections.data);
  let busy = $state(false);
  let error = $state('');

  async function load(): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await loadConnections();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  void load(); // refresh on tab open

  type Status = 'ok' | 'warn' | 'down';
  interface Row { label: string; status: Status; detail: string; }

  const rows = $derived.by((): Row[] => {
    const d = data;
    if (!d) return [];
    const ready = d.providers.backends.filter((b) => b.configured);

    return [
      {
        label: 'Inference',
        status: ready.length > 0 ? 'ok' : 'down',
        detail: ready.length > 0
          ? `${ready.length} of ${d.providers.total} backends ready · ${ready.map((b) => b.label).join(', ')}`
          : 'No backends configured - add a provider key in Providers',
      },
      {
        label: 'Memory · Englyph',
        status: !d.englyph.enabled ? 'warn' : d.englyph.reachable ? 'ok' : 'down',
        detail: !d.englyph.enabled
          ? 'Disabled in config'
          : d.englyph.reachable
            ? `Daemon reachable${d.englyph.daemonUrl ? ` · ${d.englyph.daemonUrl}` : ''}`
            : `Daemon unreachable${d.englyph.daemonUrl ? ` at ${d.englyph.daemonUrl}` : ''} - start it with python -m englyph_daemon`,
      },
      {
        label: 'Voice',
        status: !d.voice.enabled ? 'warn' : d.voice.alive ? 'ok' : 'down',
        detail: !d.voice.enabled
          ? 'Disabled in config'
          : d.voice.alive
            ? 'Sidecar running'
            : 'Sidecar not running - check mantle logs',
      },
      {
        label: 'Local models',
        status: !d.local.enabled ? 'warn' : d.local.hasBinary && d.local.models > 0 ? 'ok' : 'warn',
        detail: !d.local.enabled
          ? 'Disabled in config'
          : !d.local.hasBinary
            ? 'llama-server binary missing - drop it in local/bin/'
            : d.local.models === 0
              ? 'No models - pull one with `mantle pull`'
              : `${d.local.models} model${d.local.models === 1 ? '' : 's'}${d.local.activeModel ? ` · running ${d.local.activeModel}` : ' · idle'}`,
      },
    ];
  });
</script>

<div class="conn">
  <div class="conn-head">
    <p class="lede">Live status of mantle's subsystems. Only inference is required - the rest are optional.</p>
    <button class="recheck" type="button" disabled={busy} onclick={() => void load()}>{busy ? 'Checking…' : 'Recheck'}</button>
  </div>

  {#if error}
    <div class="conn-msg err">Couldn't load status: {error}. If you just updated mantle, restart it.</div>
  {:else if !data}
    <div class="conn-msg">Checking…</div>
  {:else}
    <div class="rows">
      {#each rows as r (r.label)}
        <div class="row {r.status}">
          <span class="dot {r.status}"></span>
          <div class="info">
            <div class="r-label">{r.label}</div>
            <div class="r-detail">{r.detail}</div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .conn { display: flex; flex-direction: column; gap: 16px; }
  .conn-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
  .lede { margin: 0; font-size: 13.5px; line-height: 1.6; color: var(--text-secondary); }
  .recheck {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    font-family: var(--font-display);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding: 6px 13px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .recheck:hover:not(:disabled) { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
  .recheck:disabled { opacity: 0.5; cursor: default; }

  .conn-msg { font-size: 13px; color: var(--text-muted); line-height: 1.5; }
  .conn-msg.err { color: var(--error); }

  .rows { display: flex; flex-direction: column; gap: 10px; }
  .row {
    display: flex;
    align-items: center;
    gap: 13px;
    padding: 13px 15px;
    background: var(--bg-panel, var(--bg-tertiary));
    border: 1px solid var(--border);
    border-left: 2px solid var(--border-strong);
  }
  .row.ok { border-left-color: color-mix(in srgb, var(--success) 60%, transparent); }
  .row.warn { border-left-color: color-mix(in srgb, var(--warning) 60%, transparent); }
  .row.down { border-left-color: color-mix(in srgb, var(--error) 60%, transparent); }

  .dot {
    flex-shrink: 0;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    box-shadow: 0 0 8px -1px currentColor;
  }
  .dot.ok { background: var(--success); color: var(--success); }
  .dot.warn { background: var(--warning); color: var(--warning); }
  .dot.down { background: var(--error); color: var(--error); }

  .info { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .r-label { font-family: var(--font-display); font-size: 15px; font-weight: 600; letter-spacing: 0.5px; color: var(--text-primary); }
  .r-detail { font-size: 12.5px; color: var(--text-muted); line-height: 1.5; }
</style>
