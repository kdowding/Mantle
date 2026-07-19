import { resolve, sep } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "fs";
import type { MantleConfig, AgentConfig, AgentVoiceConfig } from "../config/schema.js";
import { getAgent, saveConfig } from "../config/loader.js";
import type { EnglyphManager } from "../englyph/manager.js";
import type { CronRunner } from "../cron/runner.js";
import { renderTemplate, templateVars } from "./workspace-templates.js";
import { abortAgentLock, isAgentLocked } from "../agent/agent-lock.js";
import type { RealtimeManager } from "../realtime/manager.js";
import type { RoomRegistry } from "../rooms/types.js";

// ── Agent CRUD ────────────────────────────────────────────────────────────
//
// Endpoints:
//   POST   /api/agents                  create a new agent (workspace + config)
//   GET    /api/agents/:id              full editable agent config
//   GET    /api/agents/:id/footprint    enumerate everything purge would touch
//   PUT    /api/agents/:id              patch an agent's config entry
//   DELETE /api/agents/:id              soft delete (config-only; files kept)
//   DELETE /api/agents/:id?purge=true&confirm=<id>
//                                       hard delete: workspace + sessions +
//                                       this agent's cron jobs all wiped.
//                                       Englyph data is NEVER
//                                       touched (the adapter is stopped, the
//                                       store stays). Server re-validates the
//                                       confirm token against the agent id.
//
// All three mutate config.json via saveConfig and the in-memory MantleConfig
// so the next request sees the change without a restart. Englyph is
// also notified so it can spin up / tear down per-agent state.

interface CreateAgentBody {
  id?: string;
  name: string;
  accentColor?: string;
  defaultProvider?: string;
  defaultModel?: string;
  tagline?: string;       // injected into IDENTITY.md "About" section
  // Path to the Englyph store this agent reads/writes. When unset, the
  // englyph manager defaults to `~/.rev-mantle/englyph-<id>` (isolated
  // per-agent). Set explicitly to share — e.g. several agents can point at one
  // `~/.rev-mantle/englyph-shared` so memory written by
  // one is recallable by the others. The new-agent UI auto-suggests the
  // most-common path among existing agents.
  englyphPath?: string;
}

interface UpdateAgentBody {
  name?: string;
  accentColor?: string;
  defaultProvider?: string;
  defaultModel?: string;
  enabledSkills?: string[];
  disabledSkills?: string[];
  // Per-agent voice synthesis overrides. Pass null to clear all overrides
  // (resets the agent back to global config.voice.defaults). Pass an
  // object to set/replace overrides; field-level merge with existing.
  voice?: AgentVoiceConfig | null;
  // Voice reference file basename (e.g. "echo.wav"). Pass null to revert
  // to the legacy `<agent-id>.wav` convention. Field-level — doesn't
  // touch other voice config.
  voiceFile?: string | null;
  // xAI TTS voice id used when the user has the xAI voice toggle active.
  // Pass null to revert to config.realtime.defaultVoice.
  xaiVoice?: string | null;
  // Englyph store path. Pass null to clear (falls back to manager default
  // `~/.rev-mantle/englyph-<id>`). When changed, the running adapter is
  // torn down and respawned against the new path.
  englyphPath?: string | null;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

// Slugify a free-text name into a valid agent id when the caller doesn't
// supply one explicitly. Lowercases, dasherizes, strips non-id chars,
// truncates to fit ID_PATTERN.
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  // Must start with a letter — prefix `a-` if it doesn't
  return /^[a-z]/.test(base) ? base : `a-${base}`;
}

// Copy template files into a fresh agent workspace, substituting variables.
// Each .md file in templates/agent-workspace/ is rendered and written into
// the new workspace dir. Other files (if any added later) are copied
// verbatim. Returns the list of relative file names that were created.
function scaffoldWorkspace(
  templatesDir: string,
  workspaceDir: string,
  vars: Record<string, string>,
): string[] {
  if (!existsSync(templatesDir)) {
    throw new Error(`Templates directory not found: ${templatesDir}`);
  }
  mkdirSync(workspaceDir, { recursive: true });

  const created: string[] = [];
  for (const entry of readdirSync(templatesDir)) {
    const src = resolve(templatesDir, entry);
    const dst = resolve(workspaceDir, entry);
    const stat = statSync(src);
    if (stat.isDirectory()) {
      // Shallow copy of subdirs (e.g., a future skills/ template). Recursion
      // would be needed for deeper trees but the current template is flat.
      mkdirSync(dst, { recursive: true });
      for (const child of readdirSync(src)) {
        const raw = readFileSync(resolve(src, child), "utf-8");
        writeFileSync(resolve(dst, child), renderTemplate(raw, vars), "utf-8");
        created.push(`${entry}/${child}`);
      }
      continue;
    }
    if (entry.endsWith(".md")) {
      const raw = readFileSync(src, "utf-8");
      writeFileSync(dst, renderTemplate(raw, vars), "utf-8");
    } else {
      writeFileSync(dst, readFileSync(src));
    }
    created.push(entry);
  }
  return created;
}

// Persist a freshly-created agent into config.json. Stores the workspace
// as a relative path so the file stays portable; loader resolves it back
// against basePath at next read.
function appendAgentToConfig(
  basePath: string,
  agent: AgentConfig,
  workspaceRelative: string,
): void {
  saveConfig(basePath, (raw) => {
    if (!Array.isArray(raw.agents)) raw.agents = [];
    const persisted: Record<string, unknown> = {
      id: agent.id,
      name: agent.name,
      workspace: workspaceRelative,
    };
    if (agent.accentColor) persisted.accentColor = agent.accentColor;
    if (agent.avatar) persisted.avatar = agent.avatar;
    if (agent.defaultProvider) persisted.defaultProvider = agent.defaultProvider;
    if (agent.defaultModel) persisted.defaultModel = agent.defaultModel;
    if (agent.englyphPath) persisted.englyphPath = agent.englyphPath;
    if (agent.voice) persisted.voice = agent.voice;
    if (agent.voiceFile) persisted.voiceFile = agent.voiceFile;
    if (agent.xaiVoice) persisted.xaiVoice = agent.xaiVoice;
    if (agent.disabledSkills?.length) persisted.disabledSkills = agent.disabledSkills;
    if (agent.enabledSkills?.length) persisted.enabledSkills = agent.enabledSkills;
    raw.agents.push(persisted);
  });
}

function patchAgentInConfig(
  basePath: string,
  agentId: string,
  patch: Partial<Record<string, unknown>>,
): void {
  saveConfig(basePath, (raw) => {
    if (!Array.isArray(raw.agents)) return;
    const entry = raw.agents.find((a: { id?: string }) => a?.id === agentId);
    if (!entry) return;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      // Explicit null = remove the field from the persisted config (used
      // by reset-to-defaults flows like clearing voice overrides).
      if (v === null) {
        delete entry[k];
        continue;
      }
      entry[k] = v;
    }
  });
}

function removeAgentFromConfig(basePath: string, agentId: string): void {
  saveConfig(basePath, (raw) => {
    if (!Array.isArray(raw.agents)) return;
    raw.agents = raw.agents.filter((a: { id?: string }) => a?.id !== agentId);
    if (raw.defaultAgent === agentId) {
      raw.defaultAgent = raw.agents[0]?.id ?? "";
    }
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Path safety helpers ──────────────────────────────────────────────────
//
// Defense-in-depth for the purge path. A bad workspace value in config.json
// (manually edited, or a future bug in the create handler) must NEVER cause
// a recursive delete outside the project tree. Every fs op in the purge
// flow runs through `safeRemove`, which validates `target` is strictly
// nested under `mustBeUnder` before touching the disk.
//
// Comparison is normalized: same separators, lowercased on Windows-like
// paths (drive letters / folder names commonly differ in case). Equality
// is also rejected — "remove the parent itself" would wipe more than the
// caller asked for.
function isPathInside(child: string, parent: string): boolean {
  const c = resolve(child).split(sep).join("/");
  const p = resolve(parent).split(sep).join("/");
  // Windows: case-insensitive. POSIX: case-sensitive. Detect by separator
  // since `sep` is the platform's actual separator.
  const norm = sep === "\\" ? (s: string) => s.toLowerCase() : (s: string) => s;
  const cn = norm(c);
  const pn = norm(p);
  if (cn === pn) return false;
  return cn.startsWith(pn + "/");
}

function safeRemove(target: string, mustBeUnder: string): { ok: boolean; reason?: string } {
  if (!target) return { ok: false, reason: "empty target path" };
  if (!isPathInside(target, mustBeUnder)) {
    return { ok: false, reason: `Refusing to remove ${target}: not inside ${mustBeUnder}` };
  }
  if (!existsSync(target)) return { ok: true };
  try {
    rmSync(target, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// Count files (recursively) under a path, capped to avoid pathological
// scans on a misconfigured workspace. Used by the footprint endpoint to
// give the user a meaningful number, not an exact one — "this folder has
// ~14 files" is enough context for them to decide. Returns -1 if the path
// doesn't exist.
function countFilesShallow(target: string, cap = 1000): number {
  if (!existsSync(target)) return -1;
  let count = 0;
  const stack: string[] = [target];
  while (stack.length > 0 && count < cap) {
    const dir = stack.pop()!;
    try {
      for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) stack.push(full);
        else count++;
        if (count >= cap) break;
      }
    } catch {
      // Skip unreadable subdir — don't abort the whole count.
    }
  }
  return count;
}

// ── POST /api/agents ──────────────────────────────────────────────────────
export async function handleCreateAgent(
  req: Request,
  config: MantleConfig,
  basePath: string,
  englyphManager?: EnglyphManager,
): Promise<Response> {
  let body: CreateAgentBody;
  try {
    body = await req.json() as CreateAgentBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // ── Validate inputs ─────────────────────────────────────────────────
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return json({ error: "name is required" }, 400);
  }

  const id = (body.id?.trim() || slugify(body.name)).toLowerCase();
  if (!ID_PATTERN.test(id)) {
    return json({
      error: `id "${id}" is invalid — must be 2-31 chars, lowercase letters/digits/dashes, starting with a letter`,
    }, 400);
  }
  if (config.agents.find((a) => a.id === id)) {
    return json({ error: `An agent with id "${id}" already exists` }, 409);
  }

  const workspaceRelative = `./workspaces/${id}`;
  const workspaceDir = resolve(basePath, workspaceRelative);
  if (existsSync(workspaceDir)) {
    return json({
      error: `Workspace directory already exists: ${workspaceRelative}. Pick a different id, or remove the existing folder.`,
    }, 409);
  }

  // ── Scaffold workspace ──────────────────────────────────────────────
  const templatesDir = resolve(basePath, "templates", "agent-workspace");
  const tagline = body.tagline?.trim() ?? "";
  const vars = templateVars({ name: body.name, accent: body.accentColor });

  let createdFiles: string[];
  try {
    createdFiles = scaffoldWorkspace(templatesDir, workspaceDir, vars);
  } catch (err) {
    return json({
      error: `Failed to scaffold workspace: ${err instanceof Error ? err.message : err}`,
    }, 500);
  }

  // If the caller supplied a tagline, splice it into IDENTITY.md so the
  // first-run UI profile bar shows something other than the placeholder
  // sentence.
  if (tagline) {
    try {
      const identityPath = resolve(workspaceDir, "IDENTITY.md");
      const original = readFileSync(identityPath, "utf-8");
      const replaced = original.replace(
        /\{\{name\}\} is a personal AI assistant built for \{\{user\}\}\. \(Replace this line with a one-sentence purpose statement[^)]*\)/,
        `${vars.name} — ${tagline}`,
      ).replace(
        /^.*is a personal AI assistant built for.*$/m,
        `${vars.name} — ${tagline}`,
      );
      writeFileSync(identityPath, replaced, "utf-8");
    } catch {
      // tagline is best-effort; don't fail creation if rewrite misses
    }
  }

  // ── Build in-memory agent config ────────────────────────────────────
  const newAgent: AgentConfig = {
    id,
    name: body.name.trim(),
    workspace: workspaceDir,
    accentColor: body.accentColor ?? undefined,
    defaultProvider: body.defaultProvider,
    defaultModel: body.defaultModel,
    englyphPath: body.englyphPath?.trim() || undefined,
  };

  // ── Live-add to config + persist to disk ────────────────────────────
  config.agents.push(newAgent);
  appendAgentToConfig(basePath, newAgent, workspaceRelative);

  // ── Per-agent infrastructure ────────────────────────────────────────
  // Create the sessions dir up front so the UI can list (empty) sessions
  // immediately without a 404-then-create dance.
  const sessionsDir = resolve(basePath, ".mantle", "sessions", id);
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  // Spawn the agent's Englyph MCP process. Failure here is non-fatal —
  // the agent still loads, just without memory until the next restart.
  let englyphReady = false;
  if (englyphManager) {
    const client = await englyphManager.startForAgent(newAgent);
    englyphReady = client !== null;
  }

  return json({
    agent: {
      id: newAgent.id,
      name: newAgent.name,
      workspace: workspaceRelative,
      accentColor: newAgent.accentColor,
      defaultProvider: newAgent.defaultProvider,
      defaultModel: newAgent.defaultModel,
      englyphPath: newAgent.englyphPath,
    },
    workspaceFiles: createdFiles,
    englyphReady,
  }, 201);
}

// ── GET /api/agents/:id ───────────────────────────────────────────────────
//
// Returns the full editable agent config — everything the edit-agent modal
// needs to populate its fields. Distinct from /api/agents/:id/profile,
// which exposes the *display* surface (avatar URL, tagline, quotes) for
// the profile bar.
export function handleGetAgent(
  agentId: string,
  config: MantleConfig,
): Response {
  const agent = getAgent(config, agentId);
  if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

  return json({
    agent: {
      id: agent.id,
      name: agent.name,
      workspace: agent.workspace,
      accentColor: agent.accentColor,
      avatar: agent.avatar,
      defaultProvider: agent.defaultProvider,
      defaultModel: agent.defaultModel,
      englyphPath: agent.englyphPath,
      voice: agent.voice,
      voiceFile: agent.voiceFile,
      xaiVoice: agent.xaiVoice,
      enabledSkills: agent.enabledSkills,
      disabledSkills: agent.disabledSkills,
    },
  });
}

// ── PUT /api/agents/:id ───────────────────────────────────────────────────
export async function handleUpdateAgent(
  req: Request,
  agentId: string,
  config: MantleConfig,
  basePath: string,
  englyphManager?: EnglyphManager,
): Promise<Response> {
  const agent = getAgent(config, agentId);
  if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

  let body: UpdateAgentBody;
  try {
    body = await req.json() as UpdateAgentBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const patch: Record<string, unknown> = {};
  let englyphPathChanged = false;
  if (body.name !== undefined) {
    agent.name = body.name;
    patch.name = body.name;
  }
  if (body.accentColor !== undefined) {
    agent.accentColor = body.accentColor;
    patch.accentColor = body.accentColor;
  }
  if (body.defaultProvider !== undefined) {
    agent.defaultProvider = body.defaultProvider;
    patch.defaultProvider = body.defaultProvider;
  }
  if (body.defaultModel !== undefined) {
    agent.defaultModel = body.defaultModel;
    patch.defaultModel = body.defaultModel;
  }
  if (body.enabledSkills !== undefined) {
    agent.enabledSkills = body.enabledSkills;
    patch.enabledSkills = body.enabledSkills;
  }
  if (body.disabledSkills !== undefined) {
    agent.disabledSkills = body.disabledSkills;
    patch.disabledSkills = body.disabledSkills;
  }
  if (body.voice !== undefined) {
    if (body.voice === null) {
      // Reset — wipe overrides, fall back to global defaults.
      agent.voice = undefined;
      patch.voice = null;  // patchAgentInConfig converts null → delete
    } else {
      // Field-level merge so partial updates don't blow away unrelated
      // overrides. Whitelist the 3 chatterbox-streaming knobs (down from
      // 6 in the turbo era — top_k/top_p/repetition_penalty/cfm_timesteps
      // aren't exposed by generate_stream).
      const cleaned: AgentVoiceConfig = {};
      const merged: AgentVoiceConfig = { ...agent.voice };
      if (typeof body.voice.temperature === "number") cleaned.temperature = body.voice.temperature;
      if (typeof body.voice.cfgWeight === "number") cleaned.cfgWeight = body.voice.cfgWeight;
      if (typeof body.voice.exaggeration === "number") cleaned.exaggeration = body.voice.exaggeration;
      Object.assign(merged, cleaned);
      agent.voice = merged;
      patch.voice = merged;
    }
  }
  if (body.voiceFile !== undefined) {
    if (body.voiceFile === null || body.voiceFile === "") {
      // Reset to legacy convention voices/<agent-id>.wav.
      agent.voiceFile = undefined;
      patch.voiceFile = null;
    } else if (typeof body.voiceFile === "string") {
      // Strip path separators defensively — should always be a basename
      // from the dropdown but a malformed config shouldn't traverse fs.
      const safe = body.voiceFile.replace(/[/\\]/g, "");
      agent.voiceFile = safe;
      patch.voiceFile = safe;
    }
  }
  if (body.xaiVoice !== undefined) {
    if (body.xaiVoice === null || body.xaiVoice === "") {
      agent.xaiVoice = undefined;
      patch.xaiVoice = null;
    } else if (typeof body.xaiVoice === "string") {
      const safe = body.xaiVoice.trim().toLowerCase();
      if (safe) {
        agent.xaiVoice = safe;
        patch.xaiVoice = safe;
      }
    }
  }
  if (body.englyphPath !== undefined) {
    const next = body.englyphPath === null || body.englyphPath === ""
      ? undefined
      : body.englyphPath.trim();
    const prev = agent.englyphPath;
    if (prev !== next) {
      agent.englyphPath = next;
      patch.englyphPath = next ?? null;
      englyphPathChanged = true;
    }
  }

  patchAgentInConfig(basePath, agentId, patch);

  // Englyph adapter must be respawned when the store path changes — the
  // running process was started with the old ENGLYPH_PATH env var and won't
  // pick up the new one. Stop the old adapter; the next tool call will
  // lazy-spawn against the new path.
  if (englyphPathChanged && englyphManager) {
    await englyphManager.stopForAgent(agentId);
    await englyphManager.startForAgent(agent);
  }

  return json({
    agent: {
      id: agent.id,
      name: agent.name,
      accentColor: agent.accentColor,
      defaultProvider: agent.defaultProvider,
      defaultModel: agent.defaultModel,
      englyphPath: agent.englyphPath,
      voice: agent.voice,
      voiceFile: agent.voiceFile,
      xaiVoice: agent.xaiVoice,
      enabledSkills: agent.enabledSkills,
      disabledSkills: agent.disabledSkills,
    },
  });
}

// ── GET /api/agents/:id/footprint ─────────────────────────────────────────
//
// Returns a manifest of every disk + runtime artifact a purge would touch.
// The UI uses this to show the user *exactly* what's about to be deleted
// before they type the agent id to confirm. Honesty is the whole point —
// surprises here would be very bad.
//
// Englyph is reported but flagged "kept": the adapter process gets stopped
// during purge but no englyph data is ever deleted, even if this agent is
// the only one pointing at the path. (User policy — englyph stores hold
// real work that may be irreplaceable.)
export function handleAgentFootprint(
  agentId: string,
  config: MantleConfig,
  basePath: string,
  cronRunner?: CronRunner,
  rooms?: RoomRegistry,
): Response {
  const agent = getAgent(config, agentId);
  if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

  const baseMantleDir = resolve(basePath, ".mantle");
  const workspacesRoot = resolve(basePath, "workspaces");
  const sessionsRoot = resolve(baseMantleDir, "sessions");

  const sessionsDir = resolve(sessionsRoot, agentId);
  const uploadsDir = resolve(baseMantleDir, "uploads", agentId);
  const voiceLogsDir = resolve(baseMantleDir, "voice-logs", agentId);

  // Detect whether the workspace + sessions paths are safely inside the
  // project tree. If not, the UI must surface that as a refusal — purge
  // will skip them rather than risk deleting something outside.
  const workspaceInProject = isPathInside(agent.workspace, workspacesRoot);
  const sessionsInProject = isPathInside(sessionsDir, sessionsRoot);

  // Cron jobs targeting this agent.
  const cronJobs = cronRunner?.getStore().listJobs({ agentId }) ?? [];

  // Englyph-share status: any other agent pointing at the same englyphPath.
  const ownEnglyphPath = agent.englyphPath || `~/.rev-mantle/englyph-${agentId}`;
  const englyphSharedWith = config.agents
    .filter((a) => a.id !== agentId)
    .filter((a) => (a.englyphPath || `~/.rev-mantle/englyph-${a.id}`) === ownEnglyphPath)
    .map((a) => a.id);

  return json({
    agent: {
      id: agent.id,
      name: agent.name,
    },
    isDefault: config.defaultAgent === agentId,
    isLast: config.agents.length === 1,
    workspace: {
      path: agent.workspace,
      inProject: workspaceInProject,
      exists: existsSync(agent.workspace),
      fileCount: countFilesShallow(agent.workspace),
    },
    sessions: {
      path: sessionsDir,
      inProject: sessionsInProject,
      exists: existsSync(sessionsDir),
      fileCount: countFilesShallow(sessionsDir),
    },
    uploads: {
      path: uploadsDir,
      exists: existsSync(uploadsDir),
      fileCount: countFilesShallow(uploadsDir),
    },
    voiceLogs: {
      path: voiceLogsDir,
      exists: existsSync(voiceLogsDir),
      fileCount: countFilesShallow(voiceLogsDir),
    },
    cron: {
      jobCount: cronJobs.length,
      jobIds: cronJobs.map((j) => j.id),
      jobNames: cronJobs.map((j) => j.name),
    },
    // Per-room sections (music bucket, channel membership, …) — every
    // registered room reports what purge would touch.
    rooms: rooms?.footprint(agentId) ?? [],
    englyph: {
      path: ownEnglyphPath,
      shared: englyphSharedWith.length > 0,
      sharedWith: englyphSharedWith,
      // Always reported as kept — purge never deletes englyph data, period.
      action: "adapter stopped, files kept",
    },
  });
}

// ── DELETE /api/agents/:id ────────────────────────────────────────────────
//
// Two modes:
//   - Soft (default):    workspace + sessions stay on disk for recovery.
//   - Purge (?purge=true&confirm=<agentId>): full cleanup of everything
//                        except Englyph (always preserved).
//
// The `confirm` query param must match the agent id exactly — server-side
// gate that runs even if the UI's confirmation is bypassed. A mismatched
// or missing confirm during a purge request returns 400 without touching
// state.
export async function handleDeleteAgent(
  url: URL,
  agentId: string,
  config: MantleConfig,
  basePath: string,
  englyphManager?: EnglyphManager,
  cronRunner?: CronRunner,
  realtimeManager?: RealtimeManager,
  rooms?: RoomRegistry,
): Promise<Response> {
  const idx = config.agents.findIndex((a) => a.id === agentId);
  if (idx < 0) return json({ error: `Unknown agent: ${agentId}` }, 404);

  if (config.agents.length === 1) {
    return json({
      error: "Cannot delete the only remaining agent. Create another first.",
    }, 409);
  }

  const purge = url.searchParams.get("purge") === "true";
  const confirm = url.searchParams.get("confirm");

  if (purge) {
    if (!confirm) {
      return json({
        error: "purge requires confirm=<agentId> query param",
      }, 400);
    }
    if (confirm !== agentId) {
      return json({
        error: `Confirm token mismatch — expected "${agentId}", got "${confirm}". Refusing to delete.`,
      }, 400);
    }
  }

  const removed = config.agents[idx];
  const baseMantleDir = resolve(basePath, ".mantle");
  const workspacesRoot = resolve(basePath, "workspaces");
  const sessionsRoot = resolve(baseMantleDir, "sessions");
  const sessionsDir = resolve(sessionsRoot, agentId);

  // ── Pre-flight path validation (purge only) ────────────────────────
  // Anything we'd recursively delete must live inside its expected root.
  // We collect failures up-front and refuse the whole operation if a
  // critical path is suspect — better to leave a half-deleted state than
  // wipe outside the project tree. (Englyph is never touched, so its path
  // is exempt.)
  if (purge) {
    const failures: string[] = [];
    if (!isPathInside(removed.workspace, workspacesRoot)) {
      failures.push(`workspace "${removed.workspace}" is not inside ${workspacesRoot}`);
    }
    if (existsSync(sessionsDir) && !isPathInside(sessionsDir, sessionsRoot)) {
      failures.push(`sessions dir "${sessionsDir}" is not inside ${sessionsRoot}`);
    }
    if (failures.length > 0) {
      return json({
        error: "Path safety check failed. Refusing to purge to avoid deleting unrelated data.",
        failures,
        hint: "Inspect config.json and clean these up by hand.",
      }, 409);
    }
  }

  // ── Mutate state ────────────────────────────────────────────────────
  config.agents.splice(idx, 1);
  if (config.defaultAgent === agentId) {
    config.defaultAgent = config.agents[0]?.id ?? "";
  }

  removeAgentFromConfig(basePath, agentId);

  // Englyph adapter (we stop it but never touch its store path). The agent
  // is already out of config, so no new autonomous turn can lazy-spawn it.
  if (englyphManager) {
    await englyphManager.stopForAgent(agentId);
  }

  if (!purge) {
    return json({
      removed: {
        id: removed.id,
        name: removed.name,
        workspace: removed.workspace,
      },
      mode: "soft",
      note: "Workspace and sessions left on disk. Use ?purge=true&confirm=<id> for full cleanup.",
      defaultAgent: config.defaultAgent,
    });
  }

  // ── Purge: cron jobs, fs cleanup ────────────────────────────────────
  const cleanup: { step: string; ok: boolean; detail?: string }[] = [];

  // Stop in-flight work before deleting files. The agent is already out of
  // config (above), so new autonomous turns bail on getAgent(). Close any open
  // realtime call so its xAI WebSocket stops metering, abort whatever's mid-
  // flight (the lock's abort callback stops a running cron /
  // background / subagent loop — chat has no callback and is user-driven, so it
  // won't overlap a purge), then drain briefly so an aborted loop unwinds and
  // stops touching the workspace before rmSync rather than racing it.
  const abortDetail: string[] = [];
  if (realtimeManager) {
    const ended = realtimeManager.endForAgent(agentId, "server");
    if (ended > 0) abortDetail.push(`ended ${ended} realtime call(s)`);
  }
  if (abortAgentLock(agentId)) {
    const drainDeadline = Date.now() + 2000;
    while (isAgentLocked(agentId) && Date.now() < drainDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    abortDetail.push(isAgentLocked(agentId) ? "aborted loop (drain timed out)" : "aborted loop (drained)");
  }
  cleanup.push({
    step: "stop-inflight",
    ok: true,
    detail: abortDetail.length > 0 ? abortDetail.join("; ") : "nothing in flight",
  });

  // Cron jobs targeting this agent — through the RUNNER, not the store:
  // removeJob there also deletes the job's run-log JSONL and re-arms the
  // scheduler timer (going straight to the store orphaned both).
  if (cronRunner) {
    try {
      const jobs = cronRunner.getStore().listJobs({ agentId });
      for (const job of jobs) {
        cronRunner.removeJob(job.id);
      }
      cleanup.push({ step: "cron-jobs", ok: true, detail: `removed ${jobs.length}` });
    } catch (err) {
      cleanup.push({
        step: "cron-jobs",
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    cleanup.push({ step: "cron-jobs", ok: true, detail: "skipped (no cron runner)" });
  }

  // Room hooks: every registered room drops its references + per-agent
  // state (music stops this agent's pending generations + deletes the
  // bucket; channels dismiss the agent from rosters/live mics).
  if (rooms) {
    for (const r of await rooms.purgeAgent(agentId)) {
      cleanup.push({ step: `room:${r.room}`, ok: r.ok, detail: r.detail });
    }
  }

  // Sessions dir.
  const sessionsResult = safeRemove(sessionsDir, sessionsRoot);
  cleanup.push({
    step: "sessions",
    ok: sessionsResult.ok,
    detail: sessionsResult.reason,
  });

  // Uploads + voice-log trees (grew unbounded post-purge before).
  const uploadsResult = safeRemove(resolve(baseMantleDir, "uploads", agentId), baseMantleDir);
  cleanup.push({ step: "uploads", ok: uploadsResult.ok, detail: uploadsResult.reason });
  const voiceLogsResult = safeRemove(resolve(baseMantleDir, "voice-logs", agentId), baseMantleDir);
  cleanup.push({ step: "voice-logs", ok: voiceLogsResult.ok, detail: voiceLogsResult.reason });

  // Workspace dir (the big one — contains AGENTS.md, IDENTITY.md, MEMORY.md,
  // SOUL.md, USER.md, personas.json, avatar.*, any per-agent
  // skills/, plus anything the agent has written there).
  const workspaceResult = safeRemove(removed.workspace, workspacesRoot);
  cleanup.push({
    step: "workspace",
    ok: workspaceResult.ok,
    detail: workspaceResult.reason,
  });

  return json({
    removed: {
      id: removed.id,
      name: removed.name,
      workspace: removed.workspace,
    },
    mode: "purge",
    cleanup,
    englyphKept: removed.englyphPath || `~/.rev-mantle/englyph-${agentId}`,
    defaultAgent: config.defaultAgent,
  });
}
