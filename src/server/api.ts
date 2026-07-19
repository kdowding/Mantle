// The REST router. Thin by design: family modules own their routes
// (api-sessions / api-agent-surface / api-cron / api-local /
// api-voice / api-auth / api-workspace-files / api-agents) and rooms own
// their prefixes via the RoomRegistry; what remains inline here is the
// agents list, tools, the memory-pack eval endpoint, and /api/config.

import { resolve } from "path";
import { existsSync } from "fs";
import type { MantleConfig } from "../config/schema.js";
import { getAgent } from "../config/loader.js";
import { CATALOG, VENDOR_LABELS } from "../agent/providers/catalog.js";
import type { ToolRegistry } from "../tools/registry.js";
import { buildMemoryPack } from "../agent/memory-pack.js";
import { resolveContextWindow } from "../agent/compaction.js";
import type { CronRunner } from "../cron/runner.js";
import { SAFE_CRON_TOOLS } from "../cron/presets.js";
import { handleCronApi } from "./api-cron.js";
import { handleCreateAgent, handleUpdateAgent, handleDeleteAgent, handleGetAgent, handleAgentFootprint } from "./api-agents.js";
import { handleWorkspaceFilesApi } from "./api-workspace-files.js";
import { handleLocalApi } from "./api-local.js";
import { handleVoiceApi } from "./api-voice.js";
import { handleAuthApi } from "./api-auth.js";
import { handleSessionsApi } from "./api-sessions.js";
import { handleAgentSurfaceApi } from "./api-agent-surface.js";
import type { EnglyphManager } from "../englyph/manager.js";
import type { VoiceManager } from "../voice/manager.js";
import type { LocalModelManager } from "../local/manager.js";
import type { RealtimeManager } from "../realtime/manager.js";
import type { RoomRegistry } from "../rooms/types.js";
import { XAI_BUILTIN_VOICES } from "../voice/xai-tts-client.js";
import { chatToolHidden } from "./chat-tool-surface.js";
import { handleAssistRest } from "./assist.js";
import { json, readJsonBody } from "./api-helpers.js";
import { handleProvidersApi, providerKeyStates, handleUserProfileApi } from "./api-providers.js";
import { handleFeaturesApi } from "./api-features.js";
import { handleConnectionsApi } from "./api-connections.js";
import type { ProvisionManager } from "../provision/manager.js";
import { isProvisionable, type BuildType } from "../provision/types.js";

export async function handleApi(
  req: Request,
  url: URL,
  config: MantleConfig,
  registry?: ToolRegistry,
  cronRunner?: CronRunner,
  basePath?: string,
  englyphManager?: EnglyphManager,
  voiceManager?: VoiceManager,
  localModelManager?: LocalModelManager,
  realtimeManager?: RealtimeManager,
  rooms?: RoomRegistry,
  provisioner?: ProvisionManager,
): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  // ── Family delegations ────────────────────────────────────────────────

  // Cron routes
  if (path.startsWith("/api/cron/") && cronRunner) {
    return await handleCronApi(req, url, config, cronRunner);
  }

  // Room routes (music, channels, …) — each room owns a REST prefix and is
  // dispatched here; null means no room claimed the path.
  if (rooms) {
    const roomResponse = await rooms.dispatchApi(req, url);
    if (roomResponse) return roomResponse;
  }

  // Subscription-auth routes (currently just OpenAI Codex/ChatGPT)
  if (path.startsWith("/api/auth/")) {
    return await handleAuthApi(req, url, basePath ?? config.basePath);
  }

  // Local model routes (llama.cpp runtime): status + per-model settings
  // CRUD + warm/unload + the pull queue + the HF model browser.
  if (path.startsWith("/api/local/")) {
    return await handleLocalApi(req, url, config, localModelManager);
  }

  // Workspace-files routes (per-agent .md editing + section toggles + system
  // prompt preview). Match BEFORE the generic `/api/agents/:id/...` handlers
  // below so the dedicated module owns these paths.
  if (
    /^\/api\/agents\/[\w-]+\/(workspace-files|system-prompt-preview)/.test(path)
  ) {
    return await handleWorkspaceFilesApi(req, url, config);
  }

  // Voice routes — thin pass-through to the python voice sidecar.
  if (path.startsWith("/api/voice/")) {
    return await handleVoiceApi(req, url, config, voiceManager);
  }

  // Sessions family: CRUD + cross-agent GET + persona + compact + uploads.
  {
    const r = await handleSessionsApi(req, url, config, localModelManager);
    if (r) return r;
  }

  // Agent-surface family: skills toggles + avatar + profile + personas.
  {
    const r = await handleAgentSurfaceApi(req, url, config, localModelManager);
    if (r) return r;
  }

  // Deck-assist family: load / clear the hidden `assist` session.
  {
    const r = await handleAssistRest(req, url, config);
    if (r) return r;
  }

  // ── Agents CRUD ───────────────────────────────────────────────────────

  // GET /api/agents
  if (path === "/api/agents" && method === "GET") {
    return json({
      agents: config.agents.map((a) => ({
        id: a.id,
        name: a.name,
        defaultProvider: a.defaultProvider,
        defaultModel: a.defaultModel,
        accentColor: a.accentColor,
      })),
      defaultAgent: config.defaultAgent,
    });
  }

  // POST /api/agents — create a new agent (workspace + config + englyph)
  if (path === "/api/agents" && method === "POST") {
    if (!basePath) return json({ error: "Server misconfigured: basePath unavailable" }, 500);
    return await handleCreateAgent(req, config, basePath, englyphManager);
  }

  // GET /api/agents/:id/footprint — manifest of what purge would touch.
  // Match BEFORE the bare /api/agents/:id route so the path tail wins.
  const agentFootprintMatch = path.match(/^\/api\/agents\/([\w-]+)\/footprint$/);
  if (agentFootprintMatch && method === "GET") {
    if (!basePath) return json({ error: "Server misconfigured: basePath unavailable" }, 500);
    return handleAgentFootprint(agentFootprintMatch[1], config, basePath, cronRunner, rooms);
  }

  // GET /api/agents/:id — full editable agent config (powers edit modal)
  const agentUpdateMatch = path.match(/^\/api\/agents\/([\w-]+)$/);
  if (agentUpdateMatch && method === "GET") {
    return handleGetAgent(agentUpdateMatch[1], config);
  }

  // PUT /api/agents/:id — patch an existing agent's config
  if (agentUpdateMatch && method === "PUT") {
    if (!basePath) return json({ error: "Server misconfigured: basePath unavailable" }, 500);
    return await handleUpdateAgent(req, agentUpdateMatch[1], config, basePath, englyphManager);
  }

  // DELETE /api/agents/:id — soft delete by default, ?purge=true for full
  // cleanup (workspace + sessions + cron jobs + room
  // state). Query params are validated server-side; englyph store is always
  // preserved.
  if (agentUpdateMatch && method === "DELETE") {
    if (!basePath) return json({ error: "Server misconfigured: basePath unavailable" }, 500);
    return await handleDeleteAgent(url, agentUpdateMatch[1], config, basePath, englyphManager, cronRunner, realtimeManager, rooms);
  }

  // ── Inline odds & ends ────────────────────────────────────────────────

  // GET /api/tools[?agentId=]
  if (path === "/api/tools" && method === "GET") {
    // estTokens ≈ what advertising this tool costs per request (name +
    // description + JSON parameters, ~4 chars/token). Powers the tool deck's
    // context-budget readout so the weight is visible.
    //
    // When agentId is supplied the catalog is rendered from that agent's POV —
    // each tool carries `visibility` ("agent" = the live chat agent sees it,
    // "internal" = registered but hidden by the system: raw englyph_* + remember
    // + recall_source) and `disabled` (in the agent's disabledTools gate). This
    // is what lets the deck show the agent's REAL surface instead of the raw
    // registry. Without agentId it's the bare global catalog.
    const agentId = url.searchParams.get("agentId");
    const agent = agentId ? getAgent(config, agentId) : undefined;
    const disabledSet = new Set(agent?.disabledTools ?? []);
    const disableMemoryTools = process.env.MANTLE_DISABLE_MEMORY_TOOLS === "1";
    const tools = registry
      ? registry.getCatalog().map((t) => ({
          name: t.name,
          description: t.description,
          source: t.source,
          estTokens: Math.ceil(
            JSON.stringify({ name: t.name, description: t.description, parameters: t.inputSchema }).length / 4,
          ),
          visibility: chatToolHidden(t.name, disableMemoryTools) ? "internal" : "agent",
          disabled: disabledSet.has(t.name),
        }))
      : [];
    // cronSafeTools: the read-only safe-set a mechanical/aware scheduled run
    // gets — the cron tool-picker seeds "custom" selections from it, so the UI
    // never hardcodes the list (one source of truth in cron/presets.ts).
    return json({ tools, cronSafeTools: SAFE_CRON_TOOLS });
  }

  // POST /api/assist/action — execute a systems action the user CONFIRMED in the
  // deck assist (a deferred tool call). Reuses the real tool so all its
  // validation + side effects apply, run as the agent with NO allowedToolNames
  // (so no privilege containment — a user-confirmed change, like the REST path).
  // 3a: cron only; skills domains land with their tools.
  if (path === "/api/assist/action" && method === "POST") {
    const body = await readJsonBody<{ agentId?: string; kind?: string; params?: Record<string, unknown> }>(req);
    if (!body || typeof body.kind !== "string" || typeof body.agentId !== "string") {
      return json({ error: "Invalid body — expected { agentId, kind, params }" }, 400);
    }
    const actAgent = getAgent(config, body.agentId);
    if (!actAgent) return json({ error: `Unknown agent: ${body.agentId}` }, 404);
    if (!registry) return json({ error: "Tool registry unavailable" }, 503);
    const domain = body.kind.split(".")[0];
    const ctx = { agentId: actAgent.id, sessionId: "assist", workspacePath: actAgent.workspace };
    const TOOL_BY_DOMAIN: Record<string, string> = { cron: "cron_jobs", skill: "skills_manage" };
    const toolName = TOOL_BY_DOMAIN[domain];
    if (toolName && registry.has(toolName)) {
      const r = await registry.execute(toolName, body.params ?? {}, ctx);
      return json({ ok: !r.isError, outcome: r.content });
    }
    return json({ error: `Unsupported assist action: ${body.kind}` }, 400);
  }

  // POST /api/memory-pack — build the pre-inference memory pack for a query
  // WITHOUT running a turn, so the pack can be inspected/evaluated in isolation.
  // The pack is pure retrieval + assembly (no provider call, read-only on englyph),
  // so this is a cheap eval/tuning harness: fire a batch of queries, read the
  // assembled markdown back. Body: { query, agentId?, priorAssistantText?,
  // priorUserText? }. `pack` is null when retrieval surfaced nothing.
  if (path === "/api/memory-pack" && method === "POST") {
    if (!registry) return json({ error: "registry unavailable" }, 503);
    let body: {
      query?: string;
      agentId?: string;
      priorAssistantText?: string;
      priorUserText?: string;
    };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const query = (body.query ?? "").toString();
    if (!query.trim()) return json({ error: "query is required" }, 400);
    const agentId = body.agentId ?? config.defaultAgent ?? config.agents[0]?.id;
    if (!agentId || !getAgent(config, agentId)) {
      return json({ error: `unknown agent: ${agentId ?? "(none)"}` }, 404);
    }
    const context =
      body.priorAssistantText || body.priorUserText
        ? {
            priorAssistantText: body.priorAssistantText,
            priorUserText: body.priorUserText,
          }
        : undefined;
    const t0 = performance.now();
    const pack = await buildMemoryPack(registry, query, agentId, context);
    const elapsedMs = Math.round(performance.now() - t0);
    return json({ query, agentId, elapsedMs, pack: pack ?? null });
  }

  // Provider API-key management — set/clear Anthropic/OpenAI/xAI keys from the
  // options screen (write-only; never reads a key back). Behind the auth gate
  // like all of /api/*.
  if (path === "/api/config/providers") {
    return await handleProvidersApi(req, url, config, basePath ?? config.basePath);
  }

  // The user's profile (how agents should address them) — writes config.user.name.
  if (path === "/api/config/user") {
    return await handleUserProfileApi(req, config, basePath ?? config.basePath);
  }

  // Provision a heavy feature's runtime — the "Set up now" action. POST kicks
  // off the download/install (llama-server binary, or the .venv-streaming voice
  // sidecar) in the background; GET status polls progress (same polled-tray
  // pattern as the local-model pull queue). Must precede the bare features PUT.
  if (path === "/api/config/features/provision/status" && method === "GET") {
    return json({ jobs: provisioner?.getJobs() ?? [] });
  }
  const provisionMatch = path.match(/^\/api\/config\/features\/([\w-]+)\/provision$/);
  if (provisionMatch && method === "POST") {
    if (!provisioner) return json({ error: "Provisioning unavailable" }, 503);
    const feature = provisionMatch[1];
    if (!isProvisionable(feature)) {
      return json({ error: `"${feature}" has no auto-provisioner.` }, 400);
    }
    const body = (await readJsonBody<{ buildType?: string; cudaVersion?: string }>(req)) ?? {};
    const buildType = ["auto", "cpu", "cuda", "vulkan"].includes(String(body.buildType))
      ? (body.buildType as BuildType)
      : undefined;
    const res = provisioner.start(feature, {
      buildType,
      cudaVersion: typeof body.cudaVersion === "string" ? body.cudaVersion : undefined,
    });
    if (res.error) return json({ error: res.error }, 409);
    return json({ ok: true, jobId: res.jobId });
  }

  // Enable/disable a heavy feature (voice/englyph/realtime/localModels/music/cron)
  // — the setup wizard + Features panel write here. Persisted + applied live.
  if (path === "/api/config/features") {
    return await handleFeaturesApi(req, config, basePath ?? config.basePath);
  }

  // Connections — one live "is my setup working" snapshot (inference / memory /
  // voice / local) for the settings Connections tab.
  if (path === "/api/connections" && method === "GET") {
    return await handleConnectionsApi(config, { englyphManager, voiceManager, localModelManager });
  }

  if (path === "/api/config" && method === "GET") {
    return json({
      defaultProvider: config.defaultProvider,
      defaultAgent: config.defaultAgent,
      // The user's own profile (how agents address them) — seeds {{user}} for new agents.
      user: { name: config.user?.name ?? "" },
      // Provider catalog view for the cascading vendor→mode→model picker.
      // `models`/`defaultModel`/`configured` are computed live (local reads the
      // registry; codex/grok-build reflect real token presence).
      backends: CATALOG.map((b) => ({
        id: b.id,
        vendor: b.vendor,
        mode: b.mode,
        label: b.label,
        models: b.models(config, { localModelManager }),
        defaultModel: b.defaultModel(config, { localModelManager }) ?? null,
        configured: b.isConfigured(config, { localModelManager }),
      })),
      vendorLabels: VENDOR_LABELS,
      // Per-provider key presence + source (config | env | none) for the
      // options screen. Write-only: presence only, never the key value.
      providerKeys: providerKeyStates(basePath ?? config.basePath),
      agents: config.agents.map((a) => ({
        id: a.id,
        name: a.name,
        defaultProvider: a.defaultProvider,
        defaultModel: a.defaultModel,
        accentColor: a.accentColor || null,
        englyphPath: a.englyphPath || null,
        // xAI TTS voice preference, surfaced so the UI's voice tuning
        // modal can populate the dropdown without an extra round-trip.
        xaiVoice: a.xaiVoice || null,
        hasAvatar: !!(a.avatar && existsSync(resolve(a.workspace, a.avatar)))
          || existsSync(resolve(a.workspace, "avatar.png"))
          || existsSync(resolve(a.workspace, "avatar.jpg"))
          || existsSync(resolve(a.workspace, "avatar.webp")),
      })),
      englyph: { enabled: config.englyph.enabled },
      features: {
        // Realtime calls require both the feature flag AND a Grok API
        // key — the UI gates the Call button on this combined check.
        realtime: config.realtime.enabled && !!config.providers.grok.apiKey,
        // xAI TTS uses the same API key. The UI uses this to enable the
        // xAI voice toggle independently of the chatterbox sidecar.
        xaiTts: !!config.providers.grok.apiKey,
        // Local models capability. Master switch only — the UI surfaces the
        // Local pill / settings on this, then checks providers.local.models
        // (any pulled?) and /api/local/status (binary present?) for detail.
        localModels: config.localModels.enabled,
        // Music generation availability (kie.ai key present). The player UI is
        // always shown for listening; this gates the "generate" affordance.
        // (Same predicate as MusicManager.isEnabled, computed from config so
        // the router doesn't reach into a room instance.)
        music: config.music.enabled && !!config.music.apiKey,
      },
      // Session limits the chat context gauge needs: where compaction fires
      // and the per-model context windows (user-maintained lookup). Local
      // model windows are merged in live from the registry — local ids never
      // live in the static cloud map, so without this they'd show the 200k
      // default until the first turn corrected them via message_end.
      session: {
        compactionFraction: config.session.compactionFraction,
        defaultContextWindow: config.session.defaultContextWindow,
        modelContextWindows: {
          ...config.session.modelContextWindows,
          ...Object.fromEntries(
            config.providers.local.models.map((m) => [m, resolveContextWindow("local", m, config)]),
          ),
        },
      },
      // Built-in xAI voice catalog (single-sourced from the TTS client —
      // the same list realtime uses). Custom voices via xAI's Custom
      // Voices API would extend this — not implemented yet.
      xaiVoices: [...XAI_BUILTIN_VOICES],
      defaultXaiVoice: config.realtime.defaultVoice || "ara",
    });
  }

  return json({ error: "Not found" }, 404);
}
