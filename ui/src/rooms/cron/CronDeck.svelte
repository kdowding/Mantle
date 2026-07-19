<script lang="ts">
  // Cron tab of the systems deck — THE cron page (the create/edit modal is
  // gone). Left: every job with status, schedule, next-fire countdown, enable
  // toggle. Right: the selected job's inline editor (name / schedule / prompt /
  // delivery / advanced), actions (run now / delete), and its rendered run
  // history — verdicts, delivery, duration, tokens, transcript links.
  import { ui } from '../../lib/state.svelte';
  import { selectSession } from '../../lib/sessions';
  import Toggle from '../../components/Toggle.svelte';
  import ProviderModelSelect from '../../components/ProviderModelSelect.svelte';
  import {
    cron, loadJobs, toggleJob, runJob, deleteJob, fetchRuns, saveJob, describeSchedule,
    type CronJob, type CronRun,
  } from './cron.svelte';
  import { assist, setAssistTarget, discardOpen } from '../assist/assist.svelte';
  import InlineDiff from '../../components/InlineDiff.svelte';
  import ToolPicker from './ToolPicker.svelte';

  $effect(() => {
    void ui.currentAgentId;
    void loadJobs();
  });

  const selected = $derived(cron.jobs.find((j) => j.id === cron.selectedId) ?? null);

  // Live "next fire" countdown — a 20s tick keeps the labels honest.
  let nowMs = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (nowMs = Date.now()), 20_000);
    return () => clearInterval(t);
  });
  function fmtIn(ms: number | null | undefined): string {
    if (!ms) return '-';
    const d = ms - nowMs;
    if (d <= 0) return 'due';
    const m = Math.round(d / 60_000);
    if (m < 1) return 'in <1m';
    if (m < 60) return `in ${m}m`;
    if (m < 1440) return `in ${Math.floor(m / 60)}h ${m % 60}m`;
    return `in ${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  }
  function dotFor(j: CronJob): string {
    if (j.state.runningAtMs) return 'running';
    if (!j.enabled) return 'disabled';
    if (j.state.consecutiveErrors > 0) return 'error';
    return 'idle';
  }

  // ── Draft form ──────────────────────────────────────────────────────────────
  interface Draft {
    name: string;
    message: string;
    scheduleKind: 'every' | 'cron' | 'at';
    everyValue: number;
    everyUnit: 'm' | 'h' | 'd';
    cronExpr: string;
    cronTz: string;
    atValue: string;
    delivery: 'agent' | 'message' | 'notify' | 'silent';
    sessionTarget: string;
    provider: string;
    model: string;
    maxIterations: number | null;
    preset: 'mechanical' | 'aware' | 'companion';
    toolsAllow: string[]; // [] = follow preset · [names] = explicit custom surface
    egress: string;
  }
  let draft = $state<Draft | null>(null);
  let saveErr = $state<string | null>(null);
  let saving = $state(false);
  let savedFlash = $state(false);
  let pickerOpen = $state(false);

  function blankDraft(): Draft {
    return {
      name: '', message: '', scheduleKind: 'every',
      everyValue: 1, everyUnit: 'h', cronExpr: '', cronTz: '', atValue: '',
      delivery: 'agent', sessionTarget: 'isolated', provider: '', model: '', maxIterations: null,
      preset: 'mechanical', toolsAllow: [], egress: '',
    };
  }
  function draftFrom(j: CronJob): Draft {
    const d = blankDraft();
    d.name = j.name;
    d.message = j.payload.message;
    d.scheduleKind = j.schedule.kind;
    if (j.schedule.kind === 'every') {
      const ms = j.schedule.everyMs ?? 3_600_000;
      if (ms % 86_400_000 === 0) { d.everyValue = ms / 86_400_000; d.everyUnit = 'd'; }
      else if (ms % 3_600_000 === 0) { d.everyValue = ms / 3_600_000; d.everyUnit = 'h'; }
      else { d.everyValue = Math.max(1, Math.round(ms / 60_000)); d.everyUnit = 'm'; }
    } else if (j.schedule.kind === 'cron') {
      d.cronExpr = j.schedule.expr ?? '';
      d.cronTz = (j.schedule as { tz?: string }).tz ?? '';
    } else {
      d.atValue = j.schedule.at ?? '';
    }
    d.delivery = j.delivery?.mode ?? 'agent';
    d.sessionTarget = j.sessionTarget;
    d.provider = j.payload.provider ?? '';
    d.model = j.payload.model ?? '';
    d.maxIterations = j.payload.maxIterations ?? null;
    d.preset = j.payload.preset ?? 'mechanical';
    d.toolsAllow = j.payload.toolsAllow ?? [];
    d.egress = (j.payload.egressDomains ?? []).join(', ');
    return d;
  }

  // Selection / create-mode drive the draft (deep-link from openJobInDeck too).
  $effect(() => {
    if (cron.creating) {
      draft = blankDraft();
      saveErr = null;
    } else if (selected) {
      draft = draftFrom(selected);
      saveErr = null;
      void loadHistory(selected.id);
    } else {
      draft = null;
    }
  });

  function pick(id: string): void {
    cron.creating = false;
    cron.selectedId = id;
  }
  function startCreate(): void {
    cron.selectedId = null;
    cron.creating = true;
  }

  // ── Assist target: the draft rendered as a job-spec document ───────────────
  // The dock's agent sees and edits the SAME text shape on both sides; accept
  // parses it back into the form fields (throws → surfaced in the dock).
  function draftToSpec(d: Draft): string {
    const sched =
      d.scheduleKind === 'every' ? `every ${d.everyValue}${d.everyUnit}`
      : d.scheduleKind === 'cron' ? `cron ${d.cronExpr}${d.cronTz ? ` tz ${d.cronTz}` : ''}`
      : `at ${d.atValue}`;
    return [
      `name: ${d.name}`,
      `schedule: ${sched}`,
      `delivery: ${d.delivery}`,
      `session: ${d.sessionTarget}`,
      `preset: ${d.preset}`,
      ...(d.egress.trim() ? [`egress: ${d.egress.trim()}`] : []),
      'prompt: |',
      ...d.message.split('\n').map((l) => `  ${l}`),
    ].join('\n');
  }
  // Parse a spec back into the form. Mutates a COPY and commits only on success,
  // so a throw on a later line never leaves the form half-applied (the user can
  // safely reject). `prompt:` is the trailing block, so parsing stops there.
  function applySpec(text: string): void {
    if (!draft) throw new Error('No open draft');
    const d: Draft = { ...draft };
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const m = line.match(/^([a-z]+):\s*(.*)$/);
      if (!m) throw new Error(`Unparseable line: "${line.slice(0, 60)}"`);
      const key = m[1];
      const val = m[2].trim();
      if (key === 'name') d.name = val;
      else if (key === 'delivery') {
        if (!['agent', 'message', 'notify', 'silent'].includes(val)) throw new Error(`Bad delivery: "${val}"`);
        d.delivery = val as Draft['delivery'];
      } else if (key === 'session') {
        if (val !== 'isolated' && val !== 'persistent') throw new Error(`Bad session: "${val}"`);
        d.sessionTarget = val;
      } else if (key === 'preset') {
        if (!['mechanical', 'aware', 'companion'].includes(val)) throw new Error(`Bad preset: "${val}" (mechanical · aware · companion)`);
        d.preset = val as Draft['preset'];
      } else if (key === 'egress') {
        d.egress = val;
      } else if (key === 'schedule') {
        let s;
        if ((s = val.match(/^every\s+(\d+)\s*(m|h|d)$/))) {
          d.scheduleKind = 'every'; d.everyValue = Number(s[1]); d.everyUnit = s[2] as Draft['everyUnit'];
        } else if ((s = val.match(/^cron\s+(.+?)(?:\s+tz\s+(\S+))?$/))) {
          d.scheduleKind = 'cron'; d.cronExpr = s[1]; d.cronTz = s[2] ?? '';
        } else if ((s = val.match(/^at\s+(.+)$/))) {
          d.scheduleKind = 'at'; d.atValue = s[1];
        } else throw new Error(`Bad schedule: "${val}" (every 30m · cron <expr> [tz <zone>] · at <when>)`);
      } else if (key === 'prompt') {
        d.message = lines.slice(i + 1).map((l) => (l.startsWith('  ') ? l.slice(2) : l)).join('\n').replace(/\s+$/, '');
        break; // prompt is the trailing block — stop, then commit
      } else throw new Error(`Unknown key: "${key}"`);
    }
    draft = d;
  }
  $effect(() => {
    if (draft) {
      setAssistTarget({
        kind: 'cron',
        label: cron.creating ? 'new job · spec' : `${selected?.name ?? 'job'} · spec`,
        getContent: () => (draft ? draftToSpec(draft) : ''),
        apply: (c) => applySpec(c),
      });
    } else {
      // Nothing open — CREATION mode. The dock stays usable so the user can ask
      // the agent to schedule something; with no draft to edit, the agent
      // creates via cron_jobs (a confirm card), not propose_edit.
      setAssistTarget({
        kind: 'cron',
        label: 'new job',
        getContent: () => '',
        apply: () => {},
        create: true,
      });
    }
    return () => setAssistTarget(null);
  });

  // The open job's staged spec edit, rendered inline in the detail column.
  const openFile = $derived(assist.changeset.find((c) => c.id === 'open') ?? null);

  // cron's accept parses the spec back into the form (applySpec can throw) — its
  // error shows IN the diff, not the dock, so the user can reject cleanly.
  let cronApplyErr = $state<string | null>(null);
  function applyAcceptedSpec(text: string): void {
    cronApplyErr = null;
    try {
      applySpec(text);   // mutates the form fields; may throw
      discardOpen();     // success → back to the form (you still Save to persist)
    } catch (e) {
      cronApplyErr = e instanceof Error ? e.message : String(e);
      // Diff stays open with the error banner — reject is the escape hatch.
    }
  }

  // Refresh the job list after the assist applies a cron action (create/update/
  // delete). Sentinel-guarded against a double-load on mount.
  let lastAppliedTick = 0;
  $effect(() => {
    const t = assist.appliedTick;
    if (t !== lastAppliedTick) { lastAppliedTick = t; void loadJobs(); }
  });

  const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

  const PRESET_HINT: Record<Draft['preset'], string> = {
    mechanical: 'Identity only, read + report tools (web / memory / files) - no shell, write, or exec. The safe default for crawl-and-report.',
    aware: 'Adds your profile + working memory and light recall. Still read-only - no shell, write, or exec.',
    companion: 'Full identity (SOUL), memory pack, and the FULL tool surface - including shell and write. Use only when the job must act or sound like you.',
  };
  function parseEgress(s: string): string[] | undefined {
    const out = s.split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    return out.length > 0 ? out : undefined;
  }

  function buildBody(d: Draft): Record<string, unknown> {
    const schedule =
      d.scheduleKind === 'every'
        ? { kind: 'every', everyMs: Math.max(1, d.everyValue) * UNIT_MS[d.everyUnit] }
        : d.scheduleKind === 'cron'
          ? { kind: 'cron', expr: d.cronExpr.trim(), ...(d.cronTz.trim() ? { tz: d.cronTz.trim() } : {}) }
          : { kind: 'at', at: d.atValue.trim() };
    return {
      name: d.name.trim(),
      schedule,
      sessionTarget: d.sessionTarget,
      delivery: { mode: d.delivery },
      payload: {
        message: d.message,
        provider: d.provider || undefined,
        model: d.model || undefined,
        maxIterations: d.maxIterations ?? undefined,
        preset: d.preset,
        toolsAllow: d.toolsAllow,
        egressDomains: parseEgress(d.egress),
      },
    };
  }

  const draftValid = $derived.by(() => {
    if (!draft) return false;
    if (!draft.name.trim() || !draft.message.trim()) return false;
    if (draft.scheduleKind === 'cron' && !draft.cronExpr.trim()) return false;
    if (draft.scheduleKind === 'at' && !draft.atValue.trim()) return false;
    if (draft.scheduleKind === 'every' && !(draft.everyValue > 0)) return false;
    return true;
  });

  async function save(): Promise<void> {
    if (!draft || !draftValid || saving) return;
    saving = true;
    saveErr = null;
    try {
      const body = buildBody(draft);
      if (cron.creating) {
        const job = await saveJob({ ...body, agentId: ui.currentAgentId }, null);
        cron.creating = false;
        cron.selectedId = job.id;
      } else if (selected) {
        await saveJob(body, selected.id);
      }
      savedFlash = true;
      setTimeout(() => (savedFlash = false), 1200);
    } catch (e) {
      saveErr = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  async function removeSelected(): Promise<void> {
    if (!selected) return;
    const id = selected.id;
    await deleteJob(selected); // confirms inside
    if (cron.selectedId === id && !cron.jobs.some((j) => j.id === id)) cron.selectedId = null;
  }

  // ── Run history ─────────────────────────────────────────────────────────────
  let runs = $state<CronRun[] | null>(null);
  async function loadHistory(id: string): Promise<void> {
    runs = null;
    try {
      const r = await fetchRuns(id, 25);
      if (cron.selectedId === id) runs = r;
    } catch {
      if (cron.selectedId === id) runs = [];
    }
  }
  async function runNow(): Promise<void> {
    if (!selected) return;
    const id = selected.id;
    await runJob(id); // refreshes jobs after a beat
    setTimeout(() => { if (cron.selectedId === id) void loadHistory(id); }, 3000);
  }
  function fmtRunTime(ts: number | string): string {
    return new Date(ts).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
</script>

<div class="cron-deck">
  <div class="list-col">
    <button class="cd-new" type="button" onclick={startCreate}>+ new job</button>
    {#each cron.jobs as j (j.id)}
      <div class="jrow" class:active={cron.selectedId === j.id && !cron.creating}>
        <button class="jrow-main" type="button" onclick={() => pick(j.id)}>
          <span class="jrow-head">
            <span class="dot {dotFor(j)}"></span>
            <span class="jrow-name" class:off={!j.enabled}>{j.name}</span>
          </span>
          <span class="jrow-meta">
            {describeSchedule(j.schedule)}
            {#if j.enabled && j.state.nextRunAtMs}· {fmtIn(j.state.nextRunAtMs)}{/if}
            {#if j.state.snoozeUntilMs && j.state.snoozeUntilMs > nowMs}· <span class="snoozed">snoozed</span>{/if}
          </span>
        </button>
        <Toggle checked={j.enabled} label="Enable {j.name}" onchange={(v) => void toggleJob(j.id, v)} />
      </div>
    {/each}
    {#if cron.jobs.length === 0}
      <div class="cd-empty">No jobs yet. Schedule something - or ask the agent to ("remind me…", "every morning…").</div>
    {/if}
  </div>

  <div class="detail-col">
    {#if draft}
      <div class="d-head">
        <span class="d-title">{cron.creating ? 'new job' : selected?.name}</span>
        {#if selected && !cron.creating}
          <span class="d-chip {dotFor(selected)}">{dotFor(selected)}</span>
          {#if selected.createdBy === 'agent'}<span class="d-chip dim" title="Created by the agent via cron_jobs">agent-made</span>{/if}
          <span class="d-actions">
            <button class="d-run" type="button" disabled={!!selected.state.runningAtMs} onclick={() => void runNow()}>▶ run now</button>
            <button class="d-del" type="button" onclick={() => void removeSelected()}>✕ delete</button>
          </span>
        {/if}
      </div>

      {#if openFile}
        <!-- Assist staged a spec edit — review it inline. Accept parses it back
             into the form (you still Save to persist); a parse error shows here. -->
        <InlineDiff
          baseline={openFile.baseline}
          proposed={openFile.content}
          fileLabel={assist.target?.label ?? 'job · spec'}
          note={openFile.note}
          stale={draftToSpec(draft) !== openFile.baseline}
          applyError={cronApplyErr}
          onResolve={(c) => applyAcceptedSpec(c)}
          onDiscard={() => { cronApplyErr = null; discardOpen(); }}
        />
      {:else}
      <div class="d-scroll">
        <div class="form d-form deck-card">
          <div class="row">
            <label class="field">
              <span>Name</span>
              <input bind:value={draft.name} placeholder="morning-briefing" maxlength="120" />
            </label>
            <label class="field">
              <span>Schedule</span>
              <select bind:value={draft.scheduleKind}>
                <option value="every">every (interval)</option>
                <option value="cron">cron expression</option>
                <option value="at">once at</option>
              </select>
            </label>
            {#if draft.scheduleKind === 'every'}
              <label class="field">
                <span>Interval</span>
                <span class="inline">
                  <input class="num" type="number" min="1" bind:value={draft.everyValue} />
                  <select bind:value={draft.everyUnit}>
                    <option value="m">minutes</option>
                    <option value="h">hours</option>
                    <option value="d">days</option>
                  </select>
                </span>
              </label>
            {:else if draft.scheduleKind === 'cron'}
              <label class="field">
                <span>Expression</span>
                <input bind:value={draft.cronExpr} placeholder="0 8 * * 1-5" />
              </label>
              <label class="field">
                <span>Timezone</span>
                <input bind:value={draft.cronTz} placeholder="local" />
              </label>
            {:else}
              <label class="field">
                <span>When</span>
                <input bind:value={draft.atValue} placeholder="20m · 2h · 2026-06-13T09:00" />
              </label>
            {/if}
          </div>

          <div class="section">// prompt - what the agent does when this fires</div>
          <label class="field">
            <textarea class="prompt-box" bind:value={draft.message} placeholder="Check …, then report what changed. End with cron_report."></textarea>
          </label>

          <div class="section">// delivery - where the result lands</div>
          <label class="field">
            <select bind:value={draft.delivery}>
              <option value="agent">agent decides - quiet unless noteworthy (cron_report)</option>
              <option value="message">message - every result lands in your chat</option>
              <option value="notify">notify - a toast</option>
              <option value="silent">silent - transcript + history only</option>
            </select>
          </label>

          <div class="section">// access - context + tools this run gets</div>
          <label class="field">
            <select bind:value={draft.preset}>
              <option value="mechanical">mechanical - lean, read/report only (safe default)</option>
              <option value="aware">aware - + profile/memory, still read-only</option>
              <option value="companion">companion - full identity + tools (can act)</option>
            </select>
          </label>
          <div class="hint">{PRESET_HINT[draft.preset]}</div>
          <label class="field">
            <span>Tools</span>
            <button class="tool-pick" type="button" onclick={() => (pickerOpen = true)}>
              <span class="tp-state" class:custom={draft.toolsAllow.length > 0}>
                {draft.toolsAllow.length === 0 ? `following ${draft.preset} preset` : `${draft.toolsAllow.length} tools selected`}
              </span>
              <span class="tp-go">customize ▸</span>
            </button>
          </label>
          <div class="hint">Exactly which tools this job's runs may use. Following the preset stays live (new tools join automatically); a custom set is fixed to what you pick.</div>
          <label class="field">
            <span>Egress domains</span>
            <input bind:value={draft.egress} placeholder="arxiv.org, news.ycombinator.com" />
          </label>
          <div class="hint">Domains this job's web fetches may reach (subdomains included). Empty = any public site. Pin them so an injected run can't send data elsewhere.</div>

          <details class="adv">
            <summary>advanced</summary>
            <div class="adv-body">
              <label class="field">
                <span>Session</span>
                <select bind:value={draft.sessionTarget}>
                  <option value="isolated">isolated - fresh each run</option>
                  <option value="persistent">persistent - rolling transcript</option>
                </select>
              </label>
              <ProviderModelSelect bind:provider={draft.provider} bind:model={draft.model} placeholder="Agent default" />
              <label class="field">
                <span>Max iterations</span>
                <input class="num" type="number" min="1" max="50" placeholder="15" bind:value={draft.maxIterations} />
              </label>
            </div>
          </details>

          <div class="save-bar">
            {#if saveErr}<span class="err">{saveErr}</span>{/if}
            <button class="deck-save" class:flash={savedFlash} type="button" disabled={!draftValid || saving} onclick={() => void save()}>
              {savedFlash ? '✓ saved' : saving ? 'saving…' : cron.creating ? 'create job' : 'save'}
            </button>
          </div>
        </div>

        {#if selected && !cron.creating}
          {#if selected.state.lastError && selected.state.consecutiveErrors > 0}
            <div class="err-banner">{selected.state.lastError}</div>
          {/if}

          <div class="h-head">
            <span class="deck-sect">// run history</span>
            <span class="h-meta">
              {selected.state.totalRuns ?? 0} run{(selected.state.totalRuns ?? 0) === 1 ? '' : 's'}
              {#if selected.state.totalErrors}· {selected.state.totalErrors} error{selected.state.totalErrors === 1 ? '' : 's'}{/if}
            </span>
            <button class="h-refresh" type="button" onclick={() => selected && void loadHistory(selected.id)}>↻</button>
          </div>
          {#if runs === null}
            <div class="cd-empty">Loading…</div>
          {:else if runs.length === 0}
            <div class="cd-empty">No runs yet - ▶ run now to try it.</div>
          {:else}
            <div class="h-list">
              {#each runs as r, i (i)}
                <div class="hrow">
                  <span class="hr-time">{fmtRunTime(r.ts)}</span>
                  <span class="hr-status s-{r.status}">{r.status}{r.report ? ` · ${r.report.status}` : ''}</span>
                  <span class="hr-stat">{r.durationMs ? `${Math.round(r.durationMs / 1000)}s` : '-'}</span>
                  <span class="hr-stat">{r.usage?.output_tokens ? `${r.usage.output_tokens} tok` : '-'}</span>
                  <span class="hr-delivered" class:on={r.delivered && r.delivered !== 'none'}>
                    {r.snoozedMs ? `⏲ +${Math.round(r.snoozedMs / 60000)}m` : r.delivered === 'message' ? '→ chat' : r.delivered === 'notify' ? '→ toast' : ''}
                  </span>
                  <span class="hr-sum" title={r.error ?? r.report?.summary ?? r.summary ?? ''}>
                    {r.error ?? r.report?.summary ?? r.summary ?? ''}
                  </span>
                  {#if r.sessionId}
                    <button class="hr-link" type="button" title="Open the run's transcript" onclick={() => r.sessionId && void selectSession(r.sessionId)}>transcript</button>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        {/if}
      </div>
      {/if}

      <ToolPicker
        bind:open={pickerOpen}
        agentId={ui.currentAgentId}
        preset={draft.preset}
        value={draft.toolsAllow}
        onsave={(v) => { if (draft) draft.toolsAllow = v; }}
      />
    {:else}
      <div class="d-empty">
        <div class="de-mark">◷</div>
        <div>Pick a job - or create one.</div>
        <div class="de-sub">
          Jobs run on the agent's timer and end with a verdict (cron_report). Delivery decides what reaches you:
          by default the agent speaks up in chat only when something's worth saying.
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .cron-deck {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 320px 1fr;
    gap: 18px;
  }

  /* ── Job list ──────────────────────────────────────────────────────────── */
  .list-col {
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding-right: 4px;
    border-right: 1px solid var(--border);
  }
  .cd-new {
    flex-shrink: 0;
    padding: 8px 0;
    background: transparent;
    border: 1px dashed var(--accent-edge);
    color: var(--accent);
    font-family: var(--font-display);
    font-size: 11.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .cd-new:hover { background: var(--accent-faint); border-color: var(--accent); }

  .jrow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-right: 9px;
    border: 1px solid transparent;
    border-left: 2px solid transparent;
    flex-shrink: 0;
    transition: background 0.12s, border-color 0.12s;
  }
  .jrow:hover { background: var(--bg-tertiary); border-left-color: var(--border-strong); }
  .jrow.active { background: var(--accent-faint); border-color: var(--accent-edge); border-left-color: var(--accent); }
  .jrow-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 9px 0 9px 11px;
    background: transparent;
    border: none;
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
  }
  .jrow-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .jrow-name {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 14px;
    letter-spacing: 0.4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .jrow-name.off { color: var(--text-muted); }
  .jrow-meta { font-size: 11px; color: var(--text-muted); font-family: var(--font-terminal); letter-spacing: 0.4px; }
  .snoozed { color: var(--warning); }

  .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--text-muted); opacity: 0.6; }
  .dot.idle { background: var(--accent); opacity: 1; }
  .dot.running { background: var(--warning); opacity: 1; animation: cron-pulse 1.1s ease-in-out infinite; }
  .dot.error { background: var(--error); opacity: 1; }
  .dot.disabled { background: var(--text-muted); opacity: 0.5; }
  @keyframes cron-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255, 170, 0, 0.5); }
    50% { box-shadow: 0 0 6px 2px rgba(255, 170, 0, 0.25); }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot.running { animation: none; }
  }

  .cd-empty { color: var(--text-muted); font-size: 13px; padding: 8px 4px; line-height: 1.5; }

  /* ── Detail ────────────────────────────────────────────────────────────── */
  .detail-col { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
  .d-head { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; flex-shrink: 0; }
  .d-title { font-family: var(--font-display); font-weight: 700; font-size: 18px; letter-spacing: 0.5px; }
  .d-chip {
    padding: 1px 8px;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .d-chip.idle { border-color: var(--accent-edge); color: var(--accent); }
  .d-chip.running { border-color: var(--warning); color: var(--warning); }
  .d-chip.error { border-color: var(--error); color: var(--error); }
  .d-chip.dim { text-transform: none; }
  .d-actions { margin-left: auto; display: flex; gap: 8px; }
  .d-run {
    padding: 5px 13px;
    background: transparent;
    border: 1px solid var(--accent-edge);
    color: var(--accent);
    font-family: var(--font-display);
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    cursor: pointer;
  }
  .d-run:hover:not(:disabled) { background: var(--accent-faint); border-color: var(--accent); }
  .d-run:disabled { opacity: 0.4; cursor: default; }
  .d-del {
    padding: 5px 11px;
    background: transparent;
    border: 1px dashed color-mix(in srgb, var(--error) 45%, transparent);
    color: color-mix(in srgb, var(--error) 75%, var(--text-muted));
    font-family: var(--font-display);
    font-size: 10.5px;
    letter-spacing: 1px;
    text-transform: uppercase;
    cursor: pointer;
  }
  .d-del:hover { color: var(--error); border-color: var(--error); }

  .d-scroll { flex: 1; min-height: 0; overflow-y: auto; padding-right: 6px; display: flex; flex-direction: column; gap: 14px; }

  .d-form {
    flex-shrink: 0;
    /* Roomier than the dense deck base — this form is the main event of the
       cron page, not a cramped modal field. Bumps the label/input/hint scale
       (the shared form.css reads these vars). */
    --form-label: 13px;
    --form-input: 14px;
    --form-hint: 12px;
  }
  .num { width: 90px; }
  /* The prompt is the job — give it real estate. Specificity must outrank
     form.css's `.form .field textarea` (the :where() scoping adds none). */
  .d-form .field .prompt-box { min-height: 220px; resize: vertical; font-size: 13.5px; line-height: 1.55; }

  .adv summary {
    cursor: pointer;
    font-family: var(--font-display);
    font-size: 10.5px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .adv summary:hover { color: var(--accent); }
  .adv-body { display: flex; flex-direction: column; gap: 12px; padding: 10px 0 2px 10px; border-left: 1px solid var(--border-strong); margin-top: 6px; }

  .save-bar { display: flex; align-items: center; gap: 12px; justify-content: flex-end; }
  .err { color: var(--error); font-size: 12.5px; }
  .hint { font-size: 11.5px; color: var(--text-muted); line-height: 1.5; margin: -4px 0 2px; }

  .tool-pick {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 12px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-strong);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .tool-pick:hover { border-color: var(--accent-edge); }
  .tp-state { color: var(--text-muted); }
  .tp-state.custom { color: var(--accent); }
  .tp-go {
    margin-left: auto;
    font-family: var(--font-display);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 1.2px;
    text-transform: uppercase;
    color: var(--accent);
    flex-shrink: 0;
  }

  .err-banner {
    flex-shrink: 0;
    padding: 8px 12px;
    border: 1px solid color-mix(in srgb, var(--error) 40%, transparent);
    border-left: 2px solid var(--error);
    color: var(--error);
    font-size: 12.5px;
    line-height: 1.4;
  }

  /* ── History ───────────────────────────────────────────────────────────── */
  .h-head { display: flex; align-items: baseline; gap: 10px; flex-shrink: 0; border-top: 1px solid var(--border); padding-top: 12px; }
  .h-meta { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted); }
  .h-refresh { margin-left: auto; background: none; border: none; color: var(--text-muted); font-size: 13px; cursor: pointer; }
  .h-refresh:hover { color: var(--accent); }

  .h-list { display: flex; flex-direction: column; gap: 2px; }
  .hrow {
    display: grid;
    grid-template-columns: 92px 110px 44px 70px 70px 1fr auto;
    gap: 10px;
    align-items: baseline;
    padding: 6px 9px;
    border-left: 2px solid transparent;
    font-size: 12px;
    transition: background 0.12s, border-color 0.12s;
  }
  .hrow:hover { background: var(--bg-tertiary); border-left-color: var(--border-strong); }
  .hr-time { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); white-space: nowrap; }
  .hr-status { font-family: var(--font-mono); font-size: 11px; white-space: nowrap; }
  .s-ok { color: var(--success); }
  .s-error { color: var(--error); }
  .s-skipped { color: var(--text-muted); }
  .hr-stat { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); text-align: right; white-space: nowrap; }
  .hr-delivered { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); white-space: nowrap; }
  .hr-delivered.on { color: var(--accent); }
  .hr-sum {
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .hr-link {
    background: none;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 1px 7px;
    cursor: pointer;
    white-space: nowrap;
  }
  .hr-link:hover { color: var(--accent); border-color: var(--accent-edge); }

  .d-empty {
    margin: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--text-muted);
    font-size: 14px;
    text-align: center;
    max-width: 460px;
  }
  .de-mark { font-size: 28px; color: var(--accent); opacity: 0.6; }
  .de-sub { font-size: 12px; opacity: 0.8; line-height: 1.55; }

  @media (max-width: 1000px) {
    .cron-deck { grid-template-columns: 1fr; grid-template-rows: minmax(110px, 30vh) 1fr; }
    .list-col { border-right: none; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    .hrow { grid-template-columns: 80px 90px 40px 60px 1fr auto; }
    .hr-delivered { display: none; }
  }
</style>
