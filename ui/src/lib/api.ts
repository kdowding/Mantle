// Typed REST helpers against the (unchanged) Bun backend. Same contract the
// vanilla UI uses; in dev Vite proxies /api → :3333.

export interface Agent {
  id: string;
  name: string;
  hasAvatar?: boolean;
  accentColor?: string;
  defaultProvider?: string; // composite backend id, e.g. "anthropic/api"
  defaultModel?: string;
  englyphPath?: string;
}

// Full agent config from GET /api/agents/:id (the edit modal's source).
export interface AgentDetail extends Agent {
  tagline?: string;
  accentColor?: string;
}

// GET /api/agents/:id/footprint — the delete manifest (loose external JSON).
export interface AgentFootprint {
  agent?: { name?: string };
  workspace?: { path: string; exists?: boolean; inProject?: boolean; fileCount?: number };
  sessions?: { path: string; exists?: boolean; inProject?: boolean; fileCount?: number };
  cron?: { jobCount?: number; jobNames?: string[] };
  englyph?: { path?: string; shared?: boolean; sharedWith?: string[] };
  isDefault?: boolean;
}

export interface AgentDeleteResult {
  cleanup?: Array<{ step: string; ok: boolean; detail?: string }>;
  defaultAgent?: string | null;
}

export interface Profile {
  name: string;
  tagline?: string;
  accentColor?: string;
  avatarUrl?: string;
  // persona → quotes[] from the workspace's quotes.json (flat arrays land
  // under `default`). Feeds the 60s tagline rotation.
  quotes?: Record<string, string[]>;
}

export interface Backend {
  id: string; // composite, e.g. "xai/api"
  vendor: string;
  mode: string;
  label: string;
  models: string[];
  defaultModel?: string;
  configured: boolean;
}

// 'music' is the kie.ai key — not an inference provider, but it rides the same
// Providers-tab row + PUT /api/config/providers write path (server-side it
// targets config.music.apiKey instead of config.providers.*).
export type KeyVendor = 'claude' | 'openai' | 'grok' | 'music';
export type KeySource = 'config' | 'env' | 'none';
export interface ProviderKeyState {
  set: boolean;
  source: KeySource;
}

export interface MantleConfig {
  agents: Agent[];
  defaultAgent?: string;
  defaultProvider?: string;
  user?: { name: string };
  backends?: Backend[];
  vendorLabels?: Record<string, string>;
  features?: Record<string, boolean>;
  // Per-provider key presence + source (config | env | none). Write-only —
  // never the key value. Drives the Providers settings tab.
  providerKeys?: Partial<Record<KeyVendor, ProviderKeyState>>;
  session?: {
    defaultContextWindow?: number;
    modelContextWindows?: Record<string, number>;
    compactionFraction?: number;
  };
}

// Call mode locks the session at creation; an empty body creates normal chat.
export interface SessionCreateBody {
  mode?: 'call';
  callVoice?: string;
}

export interface SessionCreateResult {
  id: string;
  agentId: string;
}

export interface SessionMeta {
  id: string;
  title?: string;
  lastMessageAt?: string;
  createdAt?: string;
  messageCount?: number;
  isCron?: boolean;
  // A cron job's report thread (`cron-thread-<jobId8>`) — holds the owning
  // job's full id; the cron deck surfaces it, the sidebar (isCron) hides it.
  cronThreadFor?: string;
  isSubagent?: boolean;
  isAssist?: boolean;
  isCall?: boolean;
  callVoice?: string;
  pinned?: boolean;
}

// Raw transcript shapes from GET /api/sessions/:id (loose — external JSON,
// narrowed by `type` in lib/transcript.ts).
export interface RawBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  toolUseId?: string;
  content?: string;
  isError?: boolean;
  // image/file blocks
  fileId?: string;
  filename?: string;
  mediaType?: string;
  size?: number;
  extractedText?: string;
}

// Upload result from POST /api/agents/:id/sessions/:id/upload.
export interface UploadedFile {
  fileId: string;
  originalName: string;
  mediaType: string;
  size: number;
  category: string; // image | text | pdf | audio | video | binary
  extractedText?: string;
}
export interface RawMessage {
  role: string;
  content: RawBlock[];
  origin?: string; // "note" = steer-while-busy mid-turn note; "system-delivery"
  timestamp?: string; // ISO — every JSONL row carries one
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json() as Promise<T>;
}

export const getConfig = (): Promise<MantleConfig> => getJson('/api/config');

export interface ProviderKeyUpdate {
  ok: boolean;
  vendor: KeyVendor;
  set: boolean;
  source: KeySource;
  validation: { ok: boolean; error?: string } | null;
}

// Set (non-empty) or clear ("") a provider API key. Write-only — the response
// reports presence / source + the validation probe result, never the key.
export async function setProviderKey(vendor: KeyVendor, apiKey: string): Promise<ProviderKeyUpdate> {
  const r = await fetch('/api/config/providers', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vendor, apiKey }),
  });
  if (!r.ok) throw new Error(`PUT /api/config/providers → ${r.status}`);
  return r.json() as Promise<ProviderKeyUpdate>;
}

// Set the user's profile name (how agents address them). Persists to config + live.
export async function setUserName(name: string): Promise<{ ok: boolean; name: string }> {
  const r = await fetch('/api/config/user', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`PUT /api/config/user → ${r.status}`);
  return r.json() as Promise<{ ok: boolean; name: string }>;
}

// Enable/disable a heavy feature (voice/englyph/realtime/localModels/music/cron).
// Persists + applies to the live config; the readiness model reflects it on the
// next getConnections (callers refresh via loadConnections after this resolves).
export async function setFeatureEnabled(
  feature: string,
  enabled: boolean,
): Promise<{ ok: boolean; feature: string; enabled: boolean }> {
  const r = await fetch('/api/config/features', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feature, enabled }),
  });
  if (!r.ok) throw new Error(`PUT /api/config/features → ${r.status}`);
  return r.json() as Promise<{ ok: boolean; feature: string; enabled: boolean }>;
}

// ── Feature provisioning ("Set up now") ────────────────────────────────────
// Mirrors src/provision/types.ts. A provision job downloads/installs the
// external runtime a heavy feature needs (the llama-server binary, the voice
// venv) and streams progress the UI polls.
export interface ProvisionProgress {
  phase: 'resolving' | 'downloading' | 'verifying' | 'extracting' | 'installing' | 'starting' | 'done' | 'error';
  message?: string;
  step?: string;
  stepIndex?: number;
  stepCount?: number;
  receivedBytes?: number;
  totalBytes?: number;
  speedBytesPerSec?: number;
  error?: string;
  fallbackCommands?: string[];
}
export interface ProvisionJob {
  id: string;
  feature: string; // 'voice' | 'localModels'
  status: 'queued' | 'active' | 'done' | 'error';
  progress: ProvisionProgress | null;
  error?: string;
  fallbackCommands?: string[];
}

// Kick off provisioning a feature's runtime. Background on the server; poll
// getProvisionStatus for progress. `buildType` is the local-binary override.
export async function provisionFeature(
  feature: string,
  opts: { buildType?: string } = {},
): Promise<{ ok?: boolean; jobId?: string; error?: string }> {
  const r = await fetch(`/api/config/features/${encodeURIComponent(feature)}/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  return (await r.json().catch(() => ({ error: `HTTP ${r.status}` }))) as { ok?: boolean; jobId?: string; error?: string };
}

export const getProvisionStatus = (): Promise<{ jobs: ProvisionJob[] }> =>
  getJson('/api/config/features/provision/status');

// Per-feature readiness — the single source the UI gates, the wizard, and the
// Features panel read (mirrors src/server/feature-readiness.ts). `enabled` is
// intent (the config flag); `ready` is reality (usable right now).
export type FeatureStatus = 'off' | 'ready' | 'needs_key' | 'needs_setup';
export interface FeatureReadiness {
  id: string;
  label: string;
  enabled: boolean;
  ready: boolean;
  status: FeatureStatus;
  detail: string;
  setupHint?: string;
}

// Live "is my setup working" snapshot for the Connections settings tab.
export interface Connections {
  providers: { ready: number; total: number; backends: { id: string; label: string; configured: boolean }[] };
  englyph: { enabled: boolean; reachable: boolean; daemonUrl: string };
  voice: { enabled: boolean; alive: boolean };
  local: { enabled: boolean; hasBinary: boolean; models: number; activeModel: string | null };
  // Optional defensively — a backend predating the readiness model omits it; the
  // gates treat its absence as "unknown" and stay enabled rather than crash.
  features?: FeatureReadiness[];
}

export const getConnections = (): Promise<Connections> => getJson('/api/connections');

export const getProfile = (agentId: string): Promise<Profile> =>
  getJson(`/api/agents/${encodeURIComponent(agentId)}/profile`);

// Create a session. Default chat mode = empty body; call mode is explicit.
export async function createSession(
  agentId: string,
  body: SessionCreateBody = {},
): Promise<SessionCreateResult> {
  const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST /sessions → ${r.status}`);
  return r.json() as Promise<SessionCreateResult>;
}

export const getSessions = (agentId: string): Promise<{ sessions: SessionMeta[] }> =>
  getJson(`/api/agents/${encodeURIComponent(agentId)}/sessions`);

export const getTranscript = (sessionId: string): Promise<RawMessage[]> =>
  getJson(`/api/sessions/${encodeURIComponent(sessionId)}`);

export async function deleteSession(agentId: string, sessionId: string): Promise<void> {
  const r = await fetch(
    `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  );
  if (!r.ok) throw new Error(`DELETE /sessions → ${r.status}`);
}

// Rename / pin (user-curated sidebar meta).
export async function patchSession(
  agentId: string,
  sessionId: string,
  body: { title?: string; pinned?: boolean },
): Promise<SessionMeta> {
  const r = await fetch(
    `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  if (!r.ok) throw new Error(`PATCH /sessions → ${r.status}`);
  const data = (await r.json()) as { session: SessionMeta };
  return data.session;
}

export async function uploadFiles(
  agentId: string,
  sessionId: string,
  files: File[],
): Promise<UploadedFile[]> {
  const fd = new FormData();
  for (const f of files) fd.append('file', f);
  const r = await fetch(
    `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/upload`,
    { method: 'POST', body: fd },
  );
  if (!r.ok) throw new Error(`POST /upload → ${r.status}`);
  const { files: out } = (await r.json()) as { files: UploadedFile[] };
  return out;
}

// Serve URL for an uploaded file.
export const uploadUrl = (agentId: string, sessionId: string, fileId: string): string =>
  `/api/uploads/${encodeURIComponent(agentId)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(fileId)}`;

// ── Personas ─────────────────────────────────────────────────────────────────

export interface PersonaProfile {
  description?: string;
  style?: string;
  anchor?: string;
}

export interface PersonasResponse {
  available: boolean;
  currentState: string | null;
  profiles: Record<string, PersonaProfile>;
}

export const getPersonas = (agentId: string): Promise<PersonasResponse> =>
  getJson(`/api/agents/${encodeURIComponent(agentId)}/personas`);

export const getSessionPersona = (agentId: string, sessionId: string): Promise<{ persona: string | null }> =>
  getJson(`/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/persona`);

export async function putSessionPersona(agentId: string, sessionId: string, persona: string | null): Promise<void> {
  const r = await fetch(
    `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/persona`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persona }) },
  );
  if (!r.ok) throw new Error(`PUT /persona → ${r.status}`);
}

// Persist the agent-level default (personas.json currentState) so the choice
// survives restarts and seeds future sessions.
export async function putPersonasState(agentId: string, currentState: string): Promise<void> {
  const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/personas`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentState }),
  });
  if (!r.ok) throw new Error(`PUT /personas → ${r.status}`);
}

// ── Agent CRUD (rooms/agents) ────────────────────────────────────────────────

async function jsonOrError<T>(r: Response): Promise<T> {
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

export const getAgent = async (id: string): Promise<AgentDetail> => {
  const { agent } = await jsonOrError<{ agent: AgentDetail }>(
    await fetch(`/api/agents/${encodeURIComponent(id)}`),
  );
  return agent;
};

export const createAgent = (body: Record<string, unknown>): Promise<{ agent?: AgentDetail }> =>
  fetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => jsonOrError(r));

export const updateAgent = (id: string, body: Record<string, unknown>): Promise<{ agent?: AgentDetail }> =>
  fetch(`/api/agents/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => jsonOrError(r));

export const getAgentFootprint = (id: string): Promise<AgentFootprint> =>
  fetch(`/api/agents/${encodeURIComponent(id)}/footprint`).then((r) => jsonOrError(r));

// Purge-delete; the server independently validates the confirm token.
export const deleteAgent = (id: string): Promise<AgentDeleteResult> =>
  fetch(`/api/agents/${encodeURIComponent(id)}?purge=true&confirm=${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }).then((r) => jsonOrError(r));

export const uploadAgentAvatar = async (id: string, file: File): Promise<void> => {
  const r = await fetch(`/api/agents/${encodeURIComponent(id)}/avatar`, {
    method: 'POST',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
};

export const avatarUrl = (id: string, bust = false): string =>
  `/api/agents/${encodeURIComponent(id)}/avatar${bust ? `?t=${Date.now()}` : ''}`;
