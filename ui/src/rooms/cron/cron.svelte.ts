// Cron room — state + REST actions. The Svelte port of ui/cron.js (the first
// resident of rooms/). Bolt-on: App mounts <CronPanel/>; everything else is
// internal. Room state lives HERE, not in lib/state.svelte.ts (tier rule).
import { ui } from '../../lib/state.svelte';
import { getSessions, type SessionMeta } from '../../lib/api';
import { confirmDialog } from '../../components/confirm.svelte';

export interface CronSchedule {
  kind: 'every' | 'cron' | 'at';
  everyMs?: number;
  expr?: string;
  at?: string;
}

export interface CronEnglyph {
  storeOutcome?: boolean;
  recallContext?: string;
  recallIntent?: string;
  conditionalQuery?: string;
  conditionalThreshold?: number;
}

export interface CronReport {
  status: 'ok' | 'nothing' | 'problem';
  summary: string;
  notify?: boolean;
}

export interface CronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  createdBy?: string;
  schedule: CronSchedule;
  sessionTarget: string;
  priority: string;
  payload: {
    message: string;
    provider?: string;
    model?: string;
    maxIterations?: number;
    toolsAllow?: string[];
    preset?: 'mechanical' | 'aware' | 'companion';
    egressDomains?: string[];
  };
  tags?: string[];
  deleteAfterRun?: boolean;
  delivery?: { mode: 'agent' | 'message' | 'notify' | 'silent' };
  englyph?: CronEnglyph;
  state: {
    runningAtMs?: number | null;
    lastRunAtMs?: number | null;
    nextRunAtMs?: number | null;
    snoozeUntilMs?: number | null;
    lastRunStatus?: string;
    lastDurationMs?: number;
    consecutiveErrors: number;
    totalRuns?: number;
    totalErrors?: number;
    lastError?: string | null;
    lastReport?: CronReport;
  };
}

export interface CronRun {
  ts: number | string;
  status: string;
  durationMs?: number;
  provider?: string;
  model?: string;
  error?: string;
  summary?: string;
  sessionId?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  report?: CronReport;
  delivered?: string;
  snoozedMs?: number;
  triggeredBy?: string;
}

export const cron = $state({
  jobs: [] as CronJob[],
  cronSessions: [] as SessionMeta[], // the agent's cron-spawned sessions
  open: false, // sidebar accordion
  // Deck (the cron page): which job's detail is open, or the inline create form.
  selectedId: null as string | null,
  creating: false,
});

// Route into the cron page — from the sidebar's + / a card's Edit / the deck.
export function openJobInDeck(jobId: string | null): void {
  cron.selectedId = jobId;
  cron.creating = jobId === null;
  ui.deckTab = 'cron';
}

// Jobs + the agent's cron sessions (for each card's "Sessions (N)").
// Stale-guarded against agent switches landing mid-fetch.
export async function loadJobs(): Promise<void> {
  const agentId = ui.currentAgentId;
  if (!agentId) { cron.jobs = []; cron.cronSessions = []; return; }
  try {
    const [jobsRes, sessionsRes] = await Promise.all([
      fetch(`/api/cron/jobs?agentId=${encodeURIComponent(agentId)}`),
      getSessions(agentId).catch(() => ({ sessions: [] as SessionMeta[] })),
    ]);
    const data = (await jobsRes.json()) as { jobs?: CronJob[] };
    if (ui.currentAgentId !== agentId) return; // superseded
    cron.jobs = data.jobs ?? [];
    cron.cronSessions = (sessionsRes.sessions ?? []).filter((s) => s.isCron);
  } catch {
    if (ui.currentAgentId !== agentId) return;
    cron.jobs = [];
    cron.cronSessions = [];
  }
}

// A job's own workspace sessions: run ids start with `cron-<jobId[0:8]>`.
// The report thread (`cron-thread-<jobId8>`) deliberately doesn't match.
export function jobSessions(job: CronJob): SessionMeta[] {
  const prefix = `cron-${job.id.slice(0, 8)}`;
  return cron.cronSessions.filter((s) => s.id.startsWith(prefix));
}

// The job's report thread — where every run files its deliverable and the
// user replies to steer the next run. null until the first run files.
export function jobThread(job: CronJob): SessionMeta | null {
  const threadId = `cron-thread-${job.id.slice(0, 8)}`;
  return cron.cronSessions.find((s) => s.cronThreadFor === job.id || s.id === threadId) ?? null;
}

export async function toggleJob(id: string, enabled: boolean): Promise<void> {
  try {
    await fetch(`/api/cron/jobs/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' });
  } finally {
    setTimeout(() => void loadJobs(), 300);
  }
}

export async function runJob(id: string): Promise<void> {
  try {
    await fetch(`/api/cron/jobs/${encodeURIComponent(id)}/run`, { method: 'POST' });
  } finally {
    // The run flips state.runningAtMs server-side; give it a beat.
    setTimeout(() => void loadJobs(), 2000);
  }
}

export async function deleteJob(job: CronJob): Promise<void> {
  const ok = await confirmDialog({
    title: 'Delete cron job',
    message: `Delete cron job "${job.name}"?`,
    confirmText: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await fetch(`/api/cron/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
  } finally {
    void loadJobs();
  }
}

export async function fetchRuns(id: string, limit = 10): Promise<CronRun[]> {
  const r = await fetch(`/api/cron/jobs/${encodeURIComponent(id)}/runs?limit=${limit}`);
  const data = (await r.json()) as { runs?: CronRun[] };
  return data.runs ?? [];
}

// Create (editingId null) or update. Returns the saved job, or throws with
// the server's error message (the deck form surfaces it inline).
export async function saveJob(body: Record<string, unknown>, editingId: string | null): Promise<CronJob> {
  const r = editingId
    ? await fetch(`/api/cron/jobs/${encodeURIComponent(editingId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    : await fetch('/api/cron/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
  const data = (await r.json().catch(() => ({}))) as { job?: CronJob; error?: string };
  if (!r.ok || !data.job) throw new Error(data.error ?? `HTTP ${r.status}`);
  void loadJobs();
  return data.job;
}

export function describeSchedule(schedule: CronSchedule | undefined): string {
  if (!schedule) return '?';
  switch (schedule.kind) {
    case 'at':
      return `once at ${schedule.at}`;
    case 'every': {
      const ms = schedule.everyMs ?? 0;
      if (ms < 60000) return `every ${Math.round(ms / 1000)}s`;
      if (ms < 3600000) return `every ${Math.round(ms / 60000)}m`;
      if (ms < 86400000) return `every ${Math.round(ms / 3600000)}h`;
      return `every ${Math.round(ms / 86400000)}d`;
    }
    case 'cron':
      return `cron: ${schedule.expr}`;
    default:
      return '?';
  }
}
