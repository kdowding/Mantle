<script lang="ts">
  // Profile-bar local-runtime chip — shown while the local backend is
  // selected: state dot + active model + last-turn tok/s, full telemetry in
  // the tooltip. Click opens the settings modal. The Svelte port of
  // app.js's sidebar local-status row.
  import { prefs } from '../../lib/state.svelte';
  import { local } from './local.svelte';

  const show = $derived(prefs.backendId === 'local');
  const s = $derived(local.status);

  const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

  const dot = $derived(
    !s ? '○' : s.state === 'ready' ? '●' : s.state === 'loading' ? '◐' : s.state === 'failed' ? '✕' : '○',
  );
  const label = $derived.by(() => {
    if (!s) return 'local: status unavailable';
    if (!s.hasBinary) return 'no llama-server binary';
    if (!s.models?.length) return 'no models - add one';
    let out = s.state === 'ready' && s.activeModelId ? s.activeModelId : `runtime ${s.state}`;
    if (out.length > 26) out = `${out.slice(0, 25)}…`;
    if (local.stats?.tokPerSec) out += ` · ${local.stats.tokPerSec.toFixed(0)} tok/s`;
    return out;
  });
  const warn = $derived(!s || !s.hasBinary || !s.models?.length || s.state === 'failed');
  const title = $derived.by(() => {
    if (!s) return 'Local runtime status unavailable - is the backend up?';
    if (!s.hasBinary) return `llama-server not found - drop the CUDA build in local/bin/ (expected at ${s.binaryPath ?? '?'})`;
    if (!s.models?.length) return 'No models yet - click to browse HuggingFace and pull a GGUF';
    const parts = [`runtime ${s.state}`];
    if (s.activeModelId) parts.push(`loaded: ${s.activeModelId}`);
    if (s.error) parts.push(s.error);
    const st = local.stats;
    if (st) {
      if (st.promptTokens && s.activeContextTokens) {
        parts.push(`${fmtTok(st.promptTokens)}/${fmtTok(s.activeContextTokens)} ctx (${Math.round((st.promptTokens / s.activeContextTokens) * 100)}%)`);
      } else if (st.promptTokens) {
        parts.push(`${fmtTok(st.promptTokens)} tok prompt`);
      }
      if (st.tokPerSec) parts.push(`${st.tokPerSec.toFixed(0)} tok/s`);
      if (st.ttftMs) parts.push(`TTFT ${(st.ttftMs / 1000).toFixed(2)}s`);
    }
    parts.push('- click for model settings');
    return parts.join(' · ');
  });
</script>

{#if show}
  <button class="chip" class:warn class:ready={s?.state === 'ready'} class:loading={s?.state === 'loading'} type="button" {title} onclick={() => (local.open = true)}>
    <span class="dot">{dot}</span> {label}
  </button>
{/if}

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 280px;
    padding: 5px 9px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 11px;
    letter-spacing: 0.5px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
  }
  .chip:hover { border-color: var(--accent); color: var(--text-secondary); }
  .chip.ready { color: var(--accent); border-color: var(--accent-edge); }
  .chip.loading .dot { animation: lm-spin-pulse 1.2s ease-in-out infinite; }
  .chip.warn { color: var(--warning); border-color: rgba(255, 170, 0, 0.35); }

  .dot { flex-shrink: 0; }
  @keyframes lm-spin-pulse {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 1; }
  }
</style>
