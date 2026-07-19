<script lang="ts">
  // One cron job card: name + status dot + enable switch, schedule/status/
  // last-run meta, actions, and two lazy sub-accordions (run history + the
  // job's cron sessions, which open in the chat view via selectSession).
  import { formatTimeAgo } from '../../lib/format';
  import { selectSession } from '../../lib/sessions';
  import Toggle from '../../components/Toggle.svelte';
  import { describeSchedule, toggleJob, runJob, deleteJob, fetchRuns, jobSessions, jobThread, openJobInDeck, type CronJob, type CronRun } from './cron.svelte';

  let { job }: { job: CronJob } = $props();

  let historyOpen = $state(false);
  let runs = $state<CronRun[] | null>(null); // null = loading
  let sessionsOpen = $state(false);

  const sessions = $derived(jobSessions(job));
  const thread = $derived(jobThread(job));
  const running = $derived(Boolean(job.state.runningAtMs));
  const dot = $derived(
    running ? 'running' : !job.enabled ? 'disabled' : job.state.consecutiveErrors > 0 ? 'error' : 'idle',
  );
  const statusTxt = $derived(running ? 'running' : !job.enabled ? 'disabled' : 'idle');
  const lastRun = $derived(
    job.state.lastRunAtMs ? formatTimeAgo(new Date(job.state.lastRunAtMs).toISOString()) : 'never',
  );

  async function toggleHistory(): Promise<void> {
    historyOpen = !historyOpen;
    if (!historyOpen) return;
    runs = null;
    try {
      runs = await fetchRuns(job.id);
    } catch {
      runs = [];
    }
  }

  function fmtRunTime(ts: number | string): string {
    return new Date(ts).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
</script>

<div class="card" class:running class:errored={!running && job.state.consecutiveErrors > 0}>
  <div class="top">
    <span class="name" class:off={!job.enabled}>{job.name}</span>
    <span class="dot {dot}"></span>
    <Toggle checked={job.enabled} label="Enable job" onchange={(v) => void toggleJob(job.id, v)} />
  </div>

  <div class="meta">{describeSchedule(job.schedule)} · {statusTxt} · last: {lastRun}</div>
  {#if job.state.lastError && job.state.consecutiveErrors > 0}
    <div class="error-line">{job.state.lastError}</div>
  {:else if job.state.lastReport?.summary}
    <div class="last-sum">{job.state.lastReport.summary}</div>
  {/if}

  <div class="actions">
    {#if thread}
      <button class="act thread" type="button" onclick={() => void selectSession(thread.id)}>Thread</button>
    {/if}
    <button class="act" type="button" onclick={() => void runJob(job.id)}>Run Now</button>
    <button class="act" type="button" onclick={() => void toggleHistory()}>History</button>
    {#if sessions.length > 0}
      <button class="act" type="button" onclick={() => (sessionsOpen = !sessionsOpen)}>Sessions ({sessions.length})</button>
    {/if}
    <button class="act" type="button" onclick={() => openJobInDeck(job.id)}>Edit</button>
    <button class="act danger" type="button" onclick={() => void deleteJob(job)}>Del</button>
  </div>

  {#if historyOpen}
    <div class="history">
      {#if runs === null}
        <div class="sub-muted">Loading…</div>
      {:else if runs.length === 0}
        <div class="sub-muted">No runs yet</div>
      {:else}
        {#each runs as r, i (i)}
          <div class="run">
            <div class="run-line">
              <span>{fmtRunTime(r.ts)}</span>
              <span class="status-{r.status}">{r.status}</span>
              <span>{r.durationMs ? `${Math.round(r.durationMs / 1000)}s` : '?'}</span>
              <span class="run-prov">{r.provider ?? '?'}</span>
              {#if r.delivered && r.delivered !== 'none'}<span class="run-delivered">→ {r.delivered}</span>{/if}
            </div>
            {#if r.error}
              <div class="run-err">{r.error.slice(0, 120)}</div>
            {:else if r.report?.summary ?? r.summary}
              <div class="run-sum">{(r.report?.summary ?? r.summary ?? '').slice(0, 160)}</div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  {/if}

  {#if sessionsOpen}
    <div class="sessions">
      {#each sessions as s (s.id)}
        <button class="sess" type="button" onclick={() => void selectSession(s.id)}>
          <span class="sess-title">{(s.title || 'Untitled').replace(/^\[Cron\]\s*/, '')}</span>
          <span class="sess-meta">{formatTimeAgo(s.lastMessageAt)}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .card {
    padding: 8px 10px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-left: 2px solid var(--border-strong);
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .card.running { border-left-color: var(--accent); }
  .card.errored { border-left-color: var(--error); }

  .top { display: flex; align-items: center; gap: 7px; }
  .name {
    flex: 1;
    min-width: 0;
    font-family: var(--font-display);
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name.off { color: var(--text-muted); }

  .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .dot.idle { background: var(--accent); }
  .dot.running { background: var(--accent); box-shadow: 0 0 6px var(--accent); animation: pulse 1.2s ease-in-out infinite; }
  .dot.disabled { background: var(--text-muted); opacity: 0.5; }
  .dot.error { background: var(--error); box-shadow: 0 0 6px var(--error); }
  @keyframes pulse { 50% { opacity: 0.4; } }

  .meta { font-size: 10px; color: var(--text-muted); font-family: var(--font-display); letter-spacing: 0.5px; }
  .error-line { font-size: 10px; color: var(--error); word-break: break-word; }
  .last-sum {
    font-size: 10px;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .actions { display: flex; flex-wrap: wrap; gap: 4px; }
  .act {
    padding: 2px 7px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .act:hover { border-color: var(--accent); color: var(--accent); }
  .act.danger:hover { border-color: var(--error); color: var(--error); }
  .act.thread { border-color: var(--border-strong); color: var(--text-secondary); }
  .act.thread:hover { border-color: var(--accent); color: var(--accent); }

  .history, .sessions { display: flex; flex-direction: column; gap: 2px; }
  .sub-muted { color: var(--text-muted); font-size: 10px; }

  .run {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 2px 0;
    font-family: var(--font-mono);
    font-size: 9.5px;
    color: var(--text-secondary);
  }
  .run-line { display: flex; gap: 8px; align-items: baseline; }
  .status-ok { color: var(--accent); }
  .status-error { color: var(--error); }
  .status-skipped { color: var(--text-muted); }
  .run-prov { color: var(--text-muted); }
  .run-delivered { color: var(--text-muted); letter-spacing: 0.5px; }
  .run-err { color: var(--error); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run-sum { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .sess {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 7px;
    background: transparent;
    border: 1px solid transparent;
    border-left: 2px solid var(--border);
    color: var(--text-primary);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }
  .sess:hover { background: var(--accent-faint); border-left-color: var(--accent); }
  .sess-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sess-meta { flex-shrink: 0; font-size: 9px; color: var(--text-muted); font-family: var(--font-mono); }
</style>
