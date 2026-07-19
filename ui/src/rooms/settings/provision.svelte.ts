// Provision tray state — the polled progress behind FeatureToggles' "Set up
// now" buttons. One shared module (not per-component) so the same running job
// shows whether the user is in the setup wizard or the Settings → Features
// panel, and there's a single poll loop. Mirrors the local-pull tray
// (rooms/local/hf.svelte.ts) but keyed by feature (one job per feature).

import { provisionFeature, getProvisionStatus, type ProvisionJob } from '../../lib/api';
import { loadConnections } from '../../lib/agents';

// The heavy features that have an auto-provisioner (mirrors PROVISIONABLE_FEATURES
// in src/provision/types.ts). The "Set up now" button only renders for these.
export const PROVISIONABLE = new Set(['voice', 'localModels']);

export const provision = $state({
  jobs: {} as Record<string, ProvisionJob>, // keyed by feature id
});

let pollHandle: ReturnType<typeof setInterval> | null = null;
const seenDone = new Set<string>();

export function jobFor(feature: string): ProvisionJob | undefined {
  return provision.jobs[feature];
}

// Kick off a provision. Reflects an immediate error (e.g. 409 already-running)
// into the tray so the user sees it without waiting for the first poll.
export async function startProvision(feature: string, buildType?: string): Promise<void> {
  const res = await provisionFeature(feature, buildType ? { buildType } : {});
  if (res.error) {
    provision.jobs = {
      ...provision.jobs,
      [feature]: { id: 'local-err', feature, status: 'error', progress: { phase: 'error', message: res.error }, error: res.error },
    };
    return;
  }
  // Seed an active placeholder so the row flips to "working" before the poll.
  provision.jobs = {
    ...provision.jobs,
    [feature]: { id: res.jobId ?? 'pending', feature, status: 'active', progress: { phase: 'resolving', message: 'Starting…' } },
  };
  startPoll();
}

export function startPoll(): void {
  if (pollHandle) return;
  void pollOnce();
  pollHandle = setInterval(() => void pollOnce(), 1000);
}

async function pollOnce(): Promise<void> {
  let jobs: ProvisionJob[];
  try {
    jobs = (await getProvisionStatus()).jobs;
  } catch {
    return; // transient — keep polling
  }
  const map: Record<string, ProvisionJob> = {};
  let anyActive = false;
  for (const j of jobs) {
    map[j.feature] = j;
    if (j.status === 'active' || j.status === 'queued') anyActive = true;
    // On a freshly-finished job, refresh readiness so the pill flips to "ready"
    // and the button/progress clears.
    if (j.status === 'done' && !seenDone.has(j.id)) {
      seenDone.add(j.id);
      void loadConnections().catch(() => {});
    }
  }
  provision.jobs = map;
  if (!anyActive && pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

// Resume the tray if a provision is still running from a previous panel open.
export async function resumeProvisionIfRunning(): Promise<void> {
  try {
    const jobs = (await getProvisionStatus()).jobs;
    const map: Record<string, ProvisionJob> = {};
    let anyActive = false;
    for (const j of jobs) {
      map[j.feature] = j;
      if (j.status === 'active' || j.status === 'queued') anyActive = true;
    }
    provision.jobs = map;
    if (anyActive) startPoll();
  } catch {
    /* ignore */
  }
}
