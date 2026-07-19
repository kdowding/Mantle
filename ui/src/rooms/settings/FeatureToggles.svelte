<!-- The heavy-feature picker — one row per optional subsystem with a switch and
     a live readiness pill. Shared by the setup wizard's "pick your features"
     step and the Settings → Features panel. Toggling writes the config flag
     (PUT /api/config/features) then refreshes the shared readiness snapshot, so
     the pill + every gate update together.

     When a process-backed feature is on but not yet usable (status needs_setup),
     the auto-provisionable ones (voice, local models) show a "Set up now" button
     that downloads/installs the runtime in the background (POST …/provision),
     streaming progress into the row. On failure it surfaces the exact manual
     commands — provisioning is tiered auto-WITH-fallback, never a dead end. -->
<script lang="ts">
  import { getFeature, connections } from '../../lib/state.svelte';
  import { setFeatureEnabled, type ProvisionJob } from '../../lib/api';
  import { loadConnections } from '../../lib/agents';
  import Toggle from '../../components/Toggle.svelte';
  import { provision, startProvision, resumeProvisionIfRunning, PROVISIONABLE } from './provision.svelte';

  // `flag` is the config key the toggle writes; `readinessId` is how the
  // readiness model names it (Englyph is surfaced to users as "memory").
  const FEATURES = [
    { flag: 'englyph', readinessId: 'memory', label: 'Memory', desc: 'Framed recall across sessions. Needs the Englyph daemon running.' },
    { flag: 'voice', readinessId: 'voice', label: 'Voice', desc: 'Spoken replies + mic & song-lyric transcription. Needs the local speech sidecar.' },
    { flag: 'realtime', readinessId: 'realtime', label: 'Realtime calls', desc: 'Live voice conversations. Needs an xAI key — billed per minute.' },
    { flag: 'localModels', readinessId: 'localModels', label: 'Local models', desc: 'Run GGUF models on your own GPU via llama.cpp. Needs a llama-server binary.' },
    { flag: 'music', readinessId: 'music', label: 'Music', desc: 'Play and generate songs. The player works on its own; generation needs a kie.ai key.' },
  ] as const;

  let busy = $state<Record<string, boolean>>({});
  let showSteps = $state<Record<string, boolean>>({});

  // Resume the tray if a provision is still running from a previous panel open.
  $effect(() => { void resumeProvisionIfRunning(); });

  async function toggle(flag: string, enabled: boolean): Promise<void> {
    if (busy[flag]) return;
    busy = { ...busy, [flag]: true };
    try {
      await setFeatureEnabled(flag, enabled);
      await loadConnections(); // refresh readiness so the pill + gates update
    } catch {
      /* leave prior state on failure */
    } finally {
      busy = { ...busy, [flag]: false };
    }
  }

  async function setUp(flag: string): Promise<void> {
    showSteps = { ...showSteps, [flag]: false };
    await startProvision(flag);
  }

  function pill(status?: string): { text: string; tone: string } {
    switch (status) {
      case 'ready': return { text: 'ready', tone: 'ok' };
      case 'needs_key': return { text: 'needs a key', tone: 'warn' };
      case 'needs_setup': return { text: 'needs setup', tone: 'warn' };
      default: return { text: '', tone: '' };
    }
  }

  function fmtBytes(n?: number): string {
    if (!n || n < 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
  }
  function pct(j?: ProvisionJob): number | null {
    const p = j?.progress;
    if (p?.totalBytes && p.totalBytes > 0 && p.receivedBytes != null) {
      return Math.min(100, Math.round((p.receivedBytes / p.totalBytes) * 100));
    }
    return null;
  }
  function progressLine(j?: ProvisionJob): string {
    const p = j?.progress;
    if (!p) return '';
    if (p.phase === 'downloading') {
      const parts: string[] = [];
      if (p.step) parts.push(p.step);
      const pc = pct(j); if (pc != null) parts.push(`${pc}%`);
      if (p.speedBytesPerSec) parts.push(`${fmtBytes(p.speedBytesPerSec)}/s`);
      return parts.join(' · ') || (p.message ?? 'downloading…');
    }
    return p.message ?? p.phase;
  }
  // A provision label for the "Set up now" hint (download size warning for voice).
  function setupCaption(flag: string): string {
    return flag === 'voice'
      ? 'Downloads Python + torch (~2–3 GB, several minutes).'
      : 'Downloads the llama.cpp runtime for your platform/GPU.';
  }

  // Whether to OFFER auto-provision. The provisioner installs the runtime the
  // feature is missing — for local models that's the llama-server BINARY, so we
  // only offer it while the binary is absent. Once it's present, needs_setup
  // means "no GGUF pulled yet", which the setupHint routes to the Local panel.
  function offerSetup(flag: string, status?: string): boolean {
    if (status !== 'needs_setup' || !PROVISIONABLE.has(flag)) return false;
    if (flag === 'localModels') return connections.data?.local?.hasBinary === false;
    return true;
  }
</script>

<div class="features">
  {#each FEATURES as f (f.flag)}
    {@const feat = getFeature(f.readinessId)}
    {@const on = feat?.enabled ?? false}
    {@const p = pill(feat?.status)}
    {@const job = provision.jobs[f.flag]}
    {@const provisioning = job?.status === 'active'}
    <!-- Suppress the button while a just-finished job lingers, so it doesn't
         flash back between "done" and the readiness refresh flipping to ready. -->
    {@const canSetUp = on && job?.status !== 'done' && offerSetup(f.flag, feat?.status)}
    <div class="feat" class:on>
      <div class="feat-main">
        <div class="feat-head">
          <span class="feat-label">{f.label}</span>
          {#if on && p.text}<span class="pill {p.tone}">{p.text}</span>{/if}
        </div>
        <p class="feat-desc">{f.desc}</p>

        {#if provisioning}
          <!-- Live progress -->
          <div class="prov">
            <div class="prov-bar" class:indeterminate={pct(job) === null}>
              <span class="prov-fill" style={pct(job) !== null ? `width:${pct(job)}%` : ''}></span>
            </div>
            <p class="prov-line">{progressLine(job)}</p>
          </div>
        {:else if job?.status === 'error'}
          <!-- Failure → the manual fallback (detect+instruct floor) -->
          <p class="feat-err">✗ {job.error ?? job.progress?.message ?? 'Setup failed.'}</p>
          <div class="prov-actions">
            <button class="setup-btn" type="button" onclick={() => void setUp(f.flag)}>Try again</button>
            {#if job.fallbackCommands?.length}
              <button class="link-btn" type="button" onclick={() => showSteps = { ...showSteps, [f.flag]: !showSteps[f.flag] }}>
                {showSteps[f.flag] ? 'Hide' : 'Show'} manual steps
              </button>
            {/if}
          </div>
          {#if showSteps[f.flag] && job.fallbackCommands?.length}
            <pre class="steps">{job.fallbackCommands.join('\n')}</pre>
          {/if}
        {:else if canSetUp}
          <!-- Offer the auto-provision -->
          {#if feat?.setupHint}<p class="feat-hint">↳ {feat.setupHint}</p>{/if}
          <div class="prov-actions">
            <button class="setup-btn primary" type="button" onclick={() => void setUp(f.flag)}>Set up now</button>
            <span class="setup-cap">{setupCaption(f.flag)}</span>
          </div>
        {:else if on && feat?.setupHint}
          <p class="feat-hint">↳ {feat.setupHint}</p>
        {/if}
      </div>
      <Toggle checked={on} disabled={busy[f.flag] || provisioning} label={`Toggle ${f.label}`} onchange={(v) => void toggle(f.flag, v)} />
    </div>
  {/each}
</div>

<style>
  .features { display: flex; flex-direction: column; gap: 8px; }
  .feat {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
    padding: 12px 14px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-left: 2px solid var(--border-strong);
    transition: border-left-color 0.15s;
  }
  .feat.on { border-left-color: color-mix(in srgb, var(--accent) 55%, transparent); }
  .feat-main { min-width: 0; flex: 1; }
  .feat-head { display: flex; align-items: center; gap: 9px; }
  .feat-label { font-family: var(--font-display); font-size: 14px; font-weight: 600; letter-spacing: 0.5px; color: var(--text-primary); }
  .pill {
    font-family: var(--font-display);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding: 1px 7px;
    border: 1px solid var(--border-strong);
  }
  .pill.ok { color: var(--success); border-color: color-mix(in srgb, var(--success) 50%, transparent); }
  .pill.warn { color: var(--accent-reason, #ffb84d); border-color: color-mix(in srgb, var(--accent-reason, #ffb84d) 45%, transparent); }
  .feat-desc { margin: 4px 0 0; font-size: 12px; line-height: 1.5; color: var(--text-muted); }
  .feat-hint { margin: 5px 0 0; font-size: 11.5px; line-height: 1.45; color: var(--accent-reason, #ffb84d); font-style: italic; }
  .feat-err { margin: 6px 0 0; font-size: 12px; line-height: 1.45; color: var(--danger, #ff6b6b); }

  /* Provision progress */
  .prov { margin: 8px 0 2px; }
  .prov-bar {
    position: relative;
    height: 5px;
    background: var(--bg-primary);
    border: 1px solid var(--border-strong);
    overflow: hidden;
  }
  .prov-fill {
    position: absolute;
    left: 0; top: 0; bottom: 0;
    background: var(--accent);
    transition: width 0.3s ease;
    box-shadow: 0 0 8px var(--accent-glow);
  }
  .prov-bar.indeterminate .prov-fill {
    width: 35%;
    animation: prov-slide 1.2s ease-in-out infinite;
  }
  @keyframes prov-slide {
    0% { left: -35%; } 100% { left: 100%; }
  }
  @media (prefers-reduced-motion: reduce) {
    .prov-bar.indeterminate .prov-fill { animation: none; left: 0; width: 100%; opacity: 0.4; }
  }
  .prov-line { margin: 5px 0 0; font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .prov-actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; flex-wrap: wrap; }
  .setup-btn {
    background: transparent;
    border: 1px solid var(--accent);
    color: var(--accent);
    font-family: var(--font-display);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.8px;
    text-transform: uppercase;
    padding: 5px 12px;
    cursor: pointer;
    clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
    transition: background 0.15s, box-shadow 0.15s;
  }
  .setup-btn:hover { background: var(--accent-dim); box-shadow: 0 0 12px var(--accent-glow); }
  .setup-btn.primary { background: var(--accent); border: none; color: var(--bg-primary); }
  .setup-cap { font-size: 11px; color: var(--text-muted); }
  .link-btn {
    background: none; border: none; padding: 0; cursor: pointer;
    color: var(--text-muted); font-size: 11px; text-decoration: underline; text-underline-offset: 2px;
  }
  .link-btn:hover { color: var(--text-secondary); }
  .steps {
    margin: 7px 0 0;
    padding: 8px 10px;
    background: var(--bg-primary);
    border: 1px solid var(--border-strong);
    font-family: var(--font-mono);
    font-size: 10.5px;
    line-height: 1.5;
    color: var(--text-secondary);
    white-space: pre-wrap;
    overflow-x: auto;
  }
</style>
