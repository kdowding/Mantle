import { dirname, resolve } from "path";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { loadConfig } from "./config/loader.js";
import { ensureSecureDir } from "./auth/secure-dir.js";
import { CATALOG, configuredBackends } from "./agent/providers/catalog.js";
import { ToolRegistry } from "./tools/registry.js";
import { createFilesystemTools, setGlobalSkillsDir, setWalkIgnoreDirs } from "./tools/core/filesystem.js";
import { setFilesystemBoundary } from "./tools/core/fs-boundary.js";
import { createBashTool } from "./tools/core/bash.js";
import { createWebTool } from "./tools/core/web.js";
import { createAgentAttachmentTools } from "./tools/core/agent-attachments.js";
import { McpClient } from "./tools/mcp/client.js";
import { bridgeMcpTools } from "./tools/mcp/bridge.js";
import { EnglyphManager, bridgeEnglyphTools } from "./englyph/manager.js";
import { VoiceManager } from "./voice/manager.js";
import { RealtimeManager } from "./realtime/manager.js";
import { LocalModelManager } from "./local/manager.js";
import { ProvisionManager } from "./provision/manager.js";
import { createMemoryTools } from "./tools/core/memory.js";
import { createSessionTools } from "./tools/core/sessions.js";
import { startServer } from "./server/index.js";
import { abortAllActiveTurns, abortAllReplays } from "./server/ws.js";
import { broadcastToAllWebSockets } from "./server/ws-types.js";
import { abortAllChannelTurns } from "./rooms/channel/bridge.js";
import { CronRunner } from "./cron/runner.js";
import { createCronTool } from "./tools/core/cron.js";
import { createSkillsManageTool } from "./tools/core/skills-manage.js";
import { createMantleStatusTool } from "./tools/core/mantle-status.js";
import { createMantleGuideTool } from "./tools/core/mantle-guide.js";
import { setBaselineManual, setUserName } from "./agent/prompt-builder.js";
import { BackgroundTaskRunner } from "./agent/background-runner.js";
import { SubagentManager } from "./agent/subagent-manager.js";
import { initDeliveryOutbox, replayAllDeliveries } from "./agent/delivery-outbox.js";
import { setSyntheticTurnBroadcast } from "./agent/synthetic-turn.js";
import { setCronBroadcast } from "./cron/executor.js";
import { abortAgentLock, isAgentLocked } from "./agent/agent-lock.js";
import { createEnglyphResearchAsyncTool } from "./tools/core/research.js";
import { createSpawnAgentTool } from "./tools/core/subagents.js";
import { RoomRegistry } from "./rooms/types.js";
import { MusicRoom } from "./rooms/music/room.js";
import { ChannelRoom } from "./rooms/channel/room.js";
import { IntegrationRegistry } from "./integrations/types.js";
import { IntegrationBroker } from "./auth/integration-broker.js";
import { GitHubIntegration } from "./integrations/github/index.js";
import { GmailIntegration } from "./integrations/gmail/index.js";

const BASE_PATH = resolve(import.meta.dir, "..");
const PID_FILE = resolve(BASE_PATH, ".mantle", "mantle.pid");

console.log("[MANTLE] Starting rev://MANTLE...");

// ── Load config ────────────────────────────────────────────────────────────
// At-rest hardening for the whole runtime dir BEFORE anything writes into it:
// config.json (provider keys), sessions (personal transcripts), cron, uploads.
// POSIX mode bits handle it there; on Windows this is the icacls path.
ensureSecureDir(resolve(BASE_PATH, ".mantle"));
const config = loadConfig(BASE_PATH);
console.log(`[MANTLE] Config loaded`);
console.log(`[MANTLE]   Default provider: ${config.defaultProvider}`);
console.log(`[MANTLE]   Agents: ${config.agents.map((a) => a.id).join(", ")} (default: ${config.defaultAgent})`);
for (const agent of config.agents) {
  console.log(`[MANTLE]     ${agent.id}: ${agent.workspace}`);
}
console.log(`[MANTLE]   Englyph: ${config.englyph.enabled ? "enabled" : "disabled"}`);

// ── Global operating manual (MANTLE.md) ─────────────────────────────────────
// Load the repo-maintained agent manual once and hand it to the prompt builder
// (singleton, like the fs-boundary). It renders at the front of every in-process
// agent's stable zone. Non-fatal if absent — agents fall back to a one-line
// orientation.
{
  const manualPath = resolve(BASE_PATH, "docs", "agent-manual", "MANTLE.md");
  if (existsSync(manualPath)) {
    try {
      setBaselineManual(readFileSync(manualPath, "utf-8"));
      console.log("[MANTLE]   Operating manual: loaded (MANTLE.md)");
    } catch {
      console.warn("[MANTLE]   Operating manual: failed to read MANTLE.md — using fallback");
    }
  } else {
    console.warn(`[MANTLE]   Operating manual: MANTLE.md not found at ${manualPath} — using fallback`);
  }
}

// Seed the live {{user}} variable (the user's preferred name) into the prompt
// builder. Re-applied on every prompt build; refreshed immediately by
// PUT /api/config/user (server/api-providers.ts) so a rename lands next turn.
setUserName(config.user?.name ?? "");

// ── Local model runtime (llama.cpp) ─────────────────────────────────────────
// Owns the llama-server child process (spawn/swap/health) like the voice
// sidecar. Constructed before the provider map so the local provider can hold
// a reference. Nothing spawns here — models load lazily on first use / warm
// via /api/local/load. Seed config.providers.local from local/registry.json
// so the runtime model-lookup paths (ws/cron) resolve a valid id.
const localModelManager = new LocalModelManager(BASE_PATH, config);
{
  const localIds = localModelManager.listModelIds();
  config.providers.local.models = localIds;
  const seededDefault = localModelManager.getDefaultModelId();
  if (seededDefault && !config.providers.local.defaultModel) {
    config.providers.local.defaultModel = seededDefault;
  }
}
// Probe VRAM in the background so the model browser can show per-quant fit
// hints. Best-effort — never blocks boot.
localModelManager.detectVram().catch(() => {});

// ── Provider readiness ───────────────────────────────────────────────────
// The backend catalog (src/agent/providers/catalog.ts) is the single factory
// now: a Provider is built on demand per turn via resolveProviderTurn →
// makeProvider, and nothing is constructed at boot. We only report which
// provider backends are usable right now — key / token / model present — so
// the startup log still tells you what you can talk to.
const readyBackends = configuredBackends(config, { localModelManager });
console.log(
  `[MANTLE]   Backends ready (${readyBackends.length}/${CATALOG.length}): ${readyBackends.map((b) => b.id).join(", ") || "(none configured)"}`,
);
if (config.localModels.enabled) {
  const bin = localModelManager.hasBinary()
    ? "binary present"
    : `binary MISSING (${localModelManager.binaryPathAbs()})`;
  console.log(`[MANTLE]   Local runtime: ${localModelManager.listModelIds().length} model(s), ${bin}`);
} else {
  console.log("[MANTLE]   Local models disabled (config.localModels.enabled=false)");
}

if (readyBackends.length === 0) {
  // Setup mode — don't hard-exit. A fresh clone with no keys must still boot
  // so the UI + auth wall come up and the user can configure a backend. The
  // catalog is lazy (built per-turn), so nothing below needs a ready backend;
  // chat turns just fail until one is configured.
  console.warn(
    "[MANTLE] No backends configured — starting in setup mode so you can add one. " +
    "Set ANTHROPIC_API_KEY / OPENAI_API_KEY / XAI_API_KEY (env or .mantle/config.json), " +
    "run `mantle auth login`, or add a local model. Chat stays disabled until then.",
  );
}

// ── Register tools ─────────────────────────────────────────────────────────
const registry = new ToolRegistry();

// Tell the filesystem tools where the global skills dir lives so
// read_file can resolve `{global}/...` aliases the skill catalog
// uses. `{workspace}/...` resolves via ToolContext at call time;
// `{global}` is a singleton bound at boot.
setGlobalSkillsDir(resolve(BASE_PATH, config.globalSkillsDir));

// Filesystem-tool boundary: contain read/write/glob/grep + attach_local_file
// to allowed roots. Default = the parent of basePath (your projects folder),
// so cross-project work keeps working while $HOME, ssh keys, and system files
// stay out of reach. .mantle/auth + config.json + .env are ALWAYS denied. This is
// defense-in-depth against prompt-injection exfil — bash is NOT contained
// (it's a full shell; see fs-boundary.ts).
const configuredRoots = config.tools?.filesystem?.allowedRoots;
const allowedRoots = configuredRoots && configuredRoots.length > 0
  ? configuredRoots.map((r) => resolve(BASE_PATH, r))
  : [dirname(BASE_PATH)];
setFilesystemBoundary({
  allowedRoots,
  deniedPaths: [
    resolve(BASE_PATH, ".mantle", "auth"),
    resolve(BASE_PATH, ".mantle", "config.json"),
    // The env-var keystore is co-equal with config.json (provider keys live
    // in whichever the user chose) — deny it the same way.
    resolve(BASE_PATH, ".env"),
  ],
});

// Recursive-walk pruning for glob_files/grep_files — only override the
// built-in default when config supplies its own list (incl. [] to disable).
if (config.tools?.filesystem?.ignoreDirs) {
  setWalkIgnoreDirs(config.tools.filesystem.ignoreDirs);
}

// Core tools
registry.registerMany(createFilesystemTools());
registry.register(createBashTool());
registry.register(createWebTool());
// Agent-attachment tools land files in .mantle/uploads/... so the
// existing /api/uploads/:agentId/:sessionId/:fileId endpoint serves
// them with no extra wiring.
registry.registerMany(createAgentAttachmentTools(resolve(BASE_PATH, ".mantle"), config));

console.log(`[MANTLE] Core tools registered (${registry.size})`);

// ── Connect MCP servers ────────────────────────────────────────────────────
const mcpClients: McpClient[] = [];

// Per-agent Englyph lifecycle — one MCP server per agent, isolated stores.
// The agent CRUD endpoints in src/server/api.ts call into this manager to
// spin up englyph for newly created agents and tear it down on delete.
const englyphManager = new EnglyphManager(BASE_PATH, config);

async function connectMcpServers() {
  // Englyph — lazy per-agent spawn. We register the englyph_* tool surface
  // into the registry from a cached schema (or a one-time probe of the
  // default agent on cache miss), but the per-agent python processes
  // don't start until each agent actually calls one of those tools.
  // First boot pays for one Jina load (probe captures the schema and
  // stays warm as the default agent's client). Subsequent boots with
  // a populated cache pay zero englyph-spawn cost at startup — first
  // user message / cron run triggers the spawn.
  if (config.englyph.enabled) {
    const defs = await englyphManager.bootstrapSchema();
    const count = bridgeEnglyphTools(englyphManager, registry, defs);
    if (count > 0) {
      console.log(`[MANTLE] Englyph bridged into registry (${count} tool definitions, per-agent lazy spawn)`);
    }
  }

  // Additional MCP servers from config (shared across agents — no
  // per-agent routing for these unless configured)
  for (const serverConfig of config.mcp.servers) {
    const client = new McpClient({
      ...serverConfig,
      command: serverConfig.command.startsWith("./")
        ? resolve(BASE_PATH, serverConfig.command)
        : serverConfig.command,
      cwd: serverConfig.cwd ?? BASE_PATH,
    });
    try {
      await client.connect();
      const count = bridgeMcpTools(client, registry, undefined, `mcp:${serverConfig.name}`);
      mcpClients.push(client);
      console.log(`[MANTLE] MCP server "${serverConfig.name}" connected (${count} tools)`);
    } catch (err) {
      console.log(`[MANTLE] MCP server "${serverConfig.name}" failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ── Voice sidecar ──────────────────────────────────────────────────────────
// Spawned eagerly so the HTTP endpoint is up and ready when the user
// toggles voice mode — but the heavy ML models (chatterbox, whisper) stay
// unloaded until that toggle. Cheap to keep idle.
const voiceManager = new VoiceManager(BASE_PATH, config);

// ── Realtime (xAI Grok Voice Agent) ────────────────────────────────────────
// Owns active call sessions. No process spawn — each call opens its own
// WebSocket to xAI on demand. The manager just tracks them so we can
// close everything cleanly on shutdown.
const realtimeManager = new RealtimeManager();

// ── Graceful shutdown ──────────────────────────────────────────────────────
let cronRunner: CronRunner | null = null;
let backgroundRunner: BackgroundTaskRunner | null = null;
let subagentManager: SubagentManager | null = null;
let roomRegistry: RoomRegistry | null = null;

async function shutdown() {
  console.log("\n[MANTLE] Shutting down...");

  // Abort in-flight chat turns first so loops have a window to persist partial
  // state via their cleanup handlers before dependencies are torn down.
  // Channel volleys and voice replays live in their own maps (no session
  // lock), so they get their own sweeps — otherwise they keep streaming/
  // writing while englyph/MCP/voice tear down underneath them.
  try {
    // Sweep EVERY agent's lock + activities too — cron/outbox
    // turns hold the per-agent lock, not a session controller, so the
    // turn-level aborts above never reach them. Without this an in-flight
    // cron job races the DB close + englyph teardown below.
    let aborted = abortAllActiveTurns() + abortAllChannelTurns() + abortAllReplays();
    for (const agent of config.agents) {
      if (abortAgentLock(agent.id)) aborted++;
    }
    if (aborted > 0) {
      console.log(`[MANTLE]   aborted ${aborted} in-flight turn${aborted === 1 ? "" : "s"}`);
      // Brief drain so aborted loops unwind (release locks, flush final
      // writes) before we tear down the deps they're still holding.
      const drainDeadline = Date.now() + 2000;
      while (config.agents.some((a) => isAgentLocked(a.id)) && Date.now() < drainDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  } catch (err) {
    console.warn(`[MANTLE]   abort failed: ${err instanceof Error ? err.message : err}`);
  }

  cronRunner?.stop();
  backgroundRunner?.stop();
  subagentManager?.stop();
  await roomRegistry?.stopAll();
  // Await the child-process teardown with a bounded grace instead of
  // fire-and-forget — previously the kills were issued but exit was never
  // awaited, so a clean disconnect was microtask-ordering luck.
  await Promise.race([
    Promise.allSettled([
      ...mcpClients.map((client) => client.disconnect()),
      englyphManager.stopAll(),
    ]),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  realtimeManager.closeAll();
  await voiceManager.stop();
  await localModelManager.stop();
  // Drop our PID file so `mantle status` stops claiming we're up after
  // exit. Best-effort — if it's already gone or unwritable, skip.
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {}
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Start ──────────────────────────────────────────────────────────────────
await connectMcpServers();

// Spawn the voice sidecar in parallel with the rest of startup. We don't
// block on it — if the python interpreter is missing or the sidecar fails
// to come up, mantle still boots and voice mode just stays unavailable in
// the UI. Nothing awaits this except the boot-log line below; runtime
// callers check voiceManager.isAlive() per use.
const voiceReady = voiceManager.start().catch((err) => {
  console.error(`[MANTLE:voice] start error: ${err instanceof Error ? err.message : err}`);
  return false;
});

// Register high-level memory tools (wraps Englyph's raw MCP tools)
// These only work if Englyph connected — they delegate to englyph_* tools
if (registry.has("englyph_add_drawer")) {
  registry.registerMany(createMemoryTools(registry));
  console.log("[MANTLE] Memory tools registered — agent surface: recall, recall_history, recall_area, expand_memory, memory_status; remember + recall_source registered for internal use (hidden from the agent)");
}

// Session access tools (sessions_list, sessions_history, render_session_markdown)
registry.registerMany(createSessionTools(config));
console.log("[MANTLE] Session tools registered");

// Skills lifecycle (list/delete/enable/disable) — powers the deck assist's
// skill action cards, and lets an agent manage its own skills in chat.
registry.register(createSkillsManageTool(config));

// Read-only introspection of the running install (health, backends, agents,
// local models) — the agent-facing mirror of the Connections tab.
registry.register(createMantleStatusTool(config, { englyphManager, voiceManager, localModelManager }));

// On-demand fetch of the agent-manual corpus (docs/agent-manual/) — the depth
// behind MANTLE.md's always-loaded baseline.
registry.register(createMantleGuideTool(BASE_PATH));

// ── Background task runner + async research tool ──────────────────────────
// The runner must exist before the englyph_research_async tool is registered,
// since the tool checks for runner availability via the ToolContext on each
// invocation. Register only if Englyph connected — the async wrapper is
// useless without englyph_research available to wrap.
backgroundRunner = new BackgroundTaskRunner(config, registry);
if (registry.has("englyph_research")) {
  registry.register(createEnglyphResearchAsyncTool());
  console.log("[MANTLE] Async research tool registered (englyph_research_async)");
}

// ── Sub-agent manager + spawn_agent tool ──────────────────────────────────
// The manager tracks active children per parent session, enforces depth /
// concurrency caps, and runs child agent loops fire-and-forget. The tool
// itself reads ToolContext.subagentManager and is gated on chat sessions
// (cron / background contexts run with subagentManager=null
// so spawn_agent there returns a clean error).
subagentManager = new SubagentManager(config, registry, localModelManager);
registry.register(createSpawnAgentTool());
console.log("[MANTLE] Sub-agent spawn tool registered (spawn_agent)");

// ── Durable delivery outbox ────────────────────────────────────────────────
// Sub-agent + background results now enqueue through a per-agent JSONL outbox
// instead of being dropped when the agent is busy >60s. Registers a lock-
// release drain hook; boot replay runs once the server is up (below).
initDeliveryOutbox({ config, registry, localModelManager });
// Core never imports src/server — the delivery plumbing's UI broadcast is
// injected here at the composition root.
setSyntheticTurnBroadcast((msg) => { broadcastToAllWebSockets(msg); });
setCronBroadcast((msg) => { broadcastToAllWebSockets(msg); });

// ── Rooms ──────────────────────────────────────────────────────────────────
// Bolt-on features behind the Room contract (src/rooms/types.ts): each gets
// its server capabilities injected here, registers its tools, serves its
// REST prefix via the registry's dispatch, and participates in agent purge
// + footprint. Deleting a room = deleting its dir + its lines here.
roomRegistry = new RoomRegistry();
const musicRoom = new MusicRoom(config, BASE_PATH, (msg) => { broadcastToAllWebSockets(msg); }, voiceManager);
roomRegistry.register(musicRoom);
roomRegistry.register(new ChannelRoom(config));
{
  // Stamp each tool with its room's id so the UI catalog can group by origin.
  const roomTools = roomRegistry.list().flatMap(
    (room) => (room.tools?.() ?? []).map((t) => ({ ...t, source: t.source ?? `room:${room.id}` })),
  );
  for (const tool of roomTools) registry.register(tool);
  if (roomTools.length > 0) {
    console.log(`[MANTLE] Room tools registered (${roomTools.map((t) => t.name).join(", ")})`);
  }
  if (config.music.enabled && !musicRoom.manager.isEnabled()) {
    console.log("[MANTLE] Music generation idle (no KIE_API_KEY) — library tools only");
  }
}

// ── Integrations ────────────────────────────────────────────────────────────
// External-service connectors behind the Integration contract
// (src/integrations/types.ts). Like rooms, each is registered here and its
// native tools join the global registry; per-agent VISIBILITY is applied by the
// chat tool filter via integrationRegistry.hiddenToolNames(). Credentials live
// in the IntegrationBroker (.mantle/auth/integrations/), never config.
const integrationBroker = new IntegrationBroker(BASE_PATH);
const integrationRegistry = new IntegrationRegistry(integrationBroker);
integrationRegistry.register(new GitHubIntegration(integrationBroker, BASE_PATH));
integrationRegistry.register(new GmailIntegration(integrationBroker, BASE_PATH));
// Register OAuth specs + the user's app credentials (config.integrations.<id>)
// so the broker can refresh tokens at runtime. PAT integrations need none.
for (const integ of integrationRegistry.list()) {
  if (integ.auth.kind === "oauth2") {
    const creds = config.integrations[integ.id];
    integrationBroker.registerAuth(
      integ.id,
      integ.auth,
      creds?.clientId ? { clientId: creds.clientId, clientSecret: creds.clientSecret } : undefined,
    );
  }
}
{
  const integrationTools = integrationRegistry.tools();
  for (const tool of integrationTools) registry.register(tool);
  if (integrationTools.length > 0) {
    console.log(`[MANTLE] Integration tools registered (${integrationTools.map((t) => t.name).join(", ")})`);
  }
}

console.log(`[MANTLE] Total tools available: ${registry.size}`);
console.log(`[MANTLE] Tools: ${registry.names().join(", ")}`);

// ── Cron ──────────────────────────────────────────────────────────────────
cronRunner = new CronRunner(config, registry, localModelManager);

// Register the shared cron tool once. The ACTING agent comes from the
// per-call ToolContext (every dispatch site pins context.agentId); the
// default-agent id passed here is only a last-resort fallback for a call
// that somehow arrives without a context.
if (config.cron.enabled) {
  const defaultAgentId = config.defaultAgent || config.agents[0]?.id;
  if (defaultAgentId) {
    registry.register(createCronTool(cronRunner, config, registry, defaultAgentId));
    console.log("[MANTLE] Cron tool registered (cron_jobs)");
  }
}

// Provisioner — backs the "Set up now" feature actions (auto-download the
// llama-server binary, build the .venv-streaming voice sidecar). Reuses the
// already-constructed managers so it can re-probe readiness + hot-start voice.
const provisionManager = new ProvisionManager({ basePath: BASE_PATH, config, localModelManager, voiceManager });

startServer(config, registry, BASE_PATH, cronRunner, backgroundRunner, englyphManager, voiceManager, realtimeManager, subagentManager, localModelManager, roomRegistry, integrationRegistry, provisionManager, shutdown);

// Start cron after server is running
cronRunner.start();

// Rooms last (music resumes any generations pending before the restart)
roomRegistry.startAll();
integrationRegistry.startAll();

// Re-attempt any async deliveries (sub-agent / background results) that were
// still pending when the process last stopped.
void replayAllDeliveries();

// Surface voice readiness once it resolves so the boot log is coherent
voiceReady.then((ok) => {
  if (ok) console.log("[MANTLE] Voice sidecar ready (toggle in UI to load models)");
});

// Drop a PID file so `mantle stop` (and friends) can address this
// process directly instead of parsing netstat. Cleaned up by shutdown()
// on SIGINT/SIGTERM and by the POST /api/shutdown endpoint.
try {
  const pidDir = resolve(BASE_PATH, ".mantle");
  if (!existsSync(pidDir)) mkdirSync(pidDir, { recursive: true });
  writeFileSync(PID_FILE, String(process.pid), "utf-8");
} catch (err) {
  console.warn(`[MANTLE] Could not write PID file: ${err instanceof Error ? err.message : err}`);
}

{
  const boundAll = config.server.host === "0.0.0.0" || config.server.host === "::";
  // "localhost" is the right thing to click whether bound to loopback or all
  // interfaces; the explicit host is shown only when it's a specific non-loopback IP.
  const openHost = boundAll || config.server.host === "127.0.0.1" || config.server.host === "::1"
    ? "localhost"
    : config.server.host;
  console.log(`[MANTLE] rev://MANTLE is running. Open http://${openHost}:${config.server.port}`);
  if (boundAll) {
    console.warn(
      `[MANTLE] ⚠ Bound to ALL interfaces (${config.server.host}) — reachable from the network. ` +
        `Keep auth ON and configure TLS (server.tls), or set server.host to 127.0.0.1 for local-only.`,
    );
  }
}
