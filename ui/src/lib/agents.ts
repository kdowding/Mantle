// Agent roster + selection actions — extracted from App.svelte so rooms
// (agent CRUD) can drive the same paths after mutations. App stays the
// composition shell; this owns load/select/clear/refresh.
import { ui, connections, avatarSrc, bumpAvatar } from './state.svelte';
import { getConfig, getProfile, getConnections } from './api';
import { loadServerConfig, initPrefs, resolveBackendForAgent } from './inference';
import { newSession, loadSessions } from './sessions';
import { loadPersonas } from './personas.svelte';
import { applyAccent } from './theme';
import { lsGet, lsSet, lsRemove } from './storage';

// Per-device memory of the last-opened agent — restored on boot so a refresh
// or reopen lands on whoever you were last with (not the server default).
const AGENT_LS_KEY = 'mantle-current-agent';

// Fetch /api/config into state. On first load also seeds prefs and selects
// the default agent.
export async function loadAgents(initial = false): Promise<void> {
  const cfg = await getConfig();
  ui.agents = cfg.agents ?? [];
  loadServerConfig(cfg);
  ui.configLoaded = true;
  void loadConnections().catch(() => {}); // feature-gate readiness (non-blocking)
  if (initial) {
    initPrefs();
    // Prefer the last-opened agent (if it still exists) over the server
    // default, so the page reopens where you left off.
    const remembered = lsGet(AGENT_LS_KEY);
    const valid = remembered && ui.agents.some((a) => a.id === remembered) ? remembered : null;
    const first = valid ?? cfg.defaultAgent ?? ui.agents[0]?.id ?? null;
    if (!ui.currentAgentId && first) void selectAgent(first);
  }
}

// Refresh the live subsystem readiness snapshot (powers the feature gates +
// the Connections tab). Throws on failure so the panel can surface it; boot
// fires it and ignores failures (gates fall back to not-disabled).
export async function loadConnections(): Promise<void> {
  connections.data = await getConnections();
}

// Switch the active agent: backend/model resolution, fresh chat, session
// list, profile + accent cascade.
export async function selectAgent(id: string): Promise<void> {
  if (id === ui.currentAgentId) return;
  ui.currentAgentId = id;
  lsSet(AGENT_LS_KEY, id); // remember for next refresh/reopen (this device)
  ui.profile = null;
  resolveBackendForAgent(ui.agents.find((a) => a.id === id)); // remembered/agent-default backend+model
  newSession(); // empty chat + reset the streaming islands
  void loadSessions(); // populate the sidebar for this agent
  void loadPersonas(); // persona pill (hidden when the agent has none)
  await refreshActiveProfile();
}

// Re-fetch the active agent's profile + accent (post-edit repaint).
export async function refreshActiveProfile(): Promise<void> {
  const id = ui.currentAgentId;
  if (!id) return;
  try {
    const profile = await getProfile(id);
    if (ui.currentAgentId !== id) return; // superseded
    // Bake the current cache-bust token into the URL so a post-upload refresh
    // actually re-fetches the new image (the profile-driven surfaces all read
    // ui.profile.avatarUrl). Stable across normal switches — the token only
    // moves on upload.
    if (profile.avatarUrl) profile.avatarUrl = avatarSrc(id, profile.avatarUrl);
    ui.profile = profile;
    applyAccent(profile.accentColor);
  } catch {
    // Only clear if this fetch is still current — a slow failure must not
    // stomp the accent a newer selection already applied.
    if (ui.currentAgentId === id) applyAccent(null);
  }
}

// A fresh avatar just landed for `agentId`. Reflect it everywhere without a
// page reload: bump the cache-bust token (every mounted <img> for this agent
// re-fetches the new bytes past the stable-URL cache), flip the roster's
// hasAvatar gate so the agents-list surfaces swap initial→image (we know the
// POST succeeded, so no /api/config round-trip is needed), and re-pull the
// active profile if it's the agent on screen.
export function markAvatarUploaded(agentId: string): void {
  bumpAvatar(agentId);
  const a = ui.agents.find((x) => x.id === agentId);
  if (a) a.hasAvatar = true;
  if (ui.currentAgentId === agentId) void refreshActiveProfile();
}

// Tear down to the empty state (last agent deleted).
export function clearActiveAgent(): void {
  ui.currentAgentId = null;
  lsRemove(AGENT_LS_KEY);
  ui.profile = null;
  applyAccent(null);
  newSession();
  void loadPersonas(); // resets to unavailable
}
