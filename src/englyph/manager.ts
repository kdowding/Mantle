import { resolve } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import type { MantleConfig, AgentConfig } from "../config/schema.js";
import { McpClient } from "../tools/mcp/client.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import type { ToolDefinition } from "../agent/providers/types.js";

const DEFAULT_DAEMON_URL = "http://127.0.0.1:49765";
const DEFAULT_DAEMON_PROBE_TIMEOUT_MS = 3000;

// Per-agent Englyph lifecycle. Each agent runs its own thin ``englyph_mcp``
// adapter process pointed at the shared ``englyph-daemon`` (which mantle does
// NOT manage — start it separately). The adapter holds no embedder, no
// chroma; it's a stdio→HTTP translator. ENGLYPH_PATH is per-agent so the
// daemon resolves each adapter to a distinct store_id, and the per-agent
// memory pools stay physically isolated. The manager hands out McpClients
// keyed by agentId; the englyph tool wrappers route by `context.agentId` at
// call time so a single registry entry per englyph_* tool fans out to the
// right adapter.
export class EnglyphManager {
  private clients = new Map<string, McpClient>();
  // Cached tool defs — either loaded from disk at boot, written by a
  // probe, or written opportunistically by the first lazy spawn. Keeps
  // bridgeEnglyphTools() working without a live python process. (The old
  // "schema client" field this cache replaced is gone — every adapter
  // serves the same tool surface, so the defs are agent-agnostic.)
  private cachedToolDefs: ToolDefinition[] | null = null;
  // In-flight startForAgent() promises keyed by agentId. Dedups
  // concurrent first-spawn calls so two parallel englyph tool calls
  // don't try to launch two adapter processes for the same agent (the
  // pre-inference memory pack and a heartbeat tick can race here).
  private pendingStarts = new Map<string, Promise<McpClient | null>>();
  // Failure memo: agentId → timestamp of the last failed spawn. A
  // consistently-broken adapter (bad venv, missing module) otherwise re-paid
  // the full spawn + handshake on EVERY message — the memory pack fires
  // before each turn, so a dead adapter added its whole connect timeout to
  // every reply. One retry per cooldown window keeps it self-healing.
  private failedStarts = new Map<string, number>();
  private static readonly START_RETRY_COOLDOWN_MS = 5 * 60_000;
  // Set to false by bootstrapSchema() if the daemon /healthz probe fails.
  // When false, startForAgent short-circuits so adapters don't spawn just
  // to immediately die with "daemon unreachable" — saves boot-time stderr
  // spam and lets agents run normally without englyph for the session.
  private daemonReachable = true;
  // Tool-surface hash from the daemon's /healthz, captured at probe time. The
  // schema cache records the hash it was built under; loadSchemaCache invalidates
  // when this differs (incl. an older hashless cache), so englyph tool changes
  // (added/renamed/removed/redescribed) propagate to the agent without a manual
  // cache wipe. Null when the daemon predates the hash field — then we degrade to
  // the old always-trust-cache behavior.
  private daemonToolsHash: string | null = null;

  constructor(
    private basePath: string,
    private config: MantleConfig,
  ) {}

  // Where the englyph tool-surface cache lives. One file shared across
  // agents — every adapter exposes the same tool list regardless of which
  // store it targets.
  private get schemaCachePath(): string {
    return resolve(this.basePath, ".mantle", "cache", "englyph-schema.json");
  }

  // Resolved daemon URL with the documented default.
  private get daemonUrl(): string {
    return this.config.englyph.daemonUrl || DEFAULT_DAEMON_URL;
  }

  // Build the canonical command/args/env for spawning a per-agent englyph_mcp
  // adapter. Single source of truth for both in-process spawn (_doStart) and
  // the Claude CLI scaffold (which writes a sibling MCP config file).
  buildAdapterSpawnConfig(agent: AgentConfig): {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  } {
    const command = resolve(this.basePath, this.config.englyph.pythonPath);
    const env: Record<string, string> = {
      ENGLYPH_DAEMON_URL: this.daemonUrl,
      ENGLYPH_PATH: this.resolveEnglyphPath(agent),
    };
    if (this.config.englyph.daemonAuthFile) {
      env.ENGLYPH_AUTH_FILE = this.config.englyph.daemonAuthFile;
    }
    return { command, args: ["-m", "englyph_mcp"], cwd: this.basePath, env };
  }

  // Look up an agent config by id. Used by the bridge wrapper to
  // resolve agentId → AgentConfig at lazy-spawn time.
  findAgent(agentId: string): AgentConfig | undefined {
    return this.config.agents.find((a) => a.id === agentId);
  }

  loadSchemaCache(): ToolDefinition[] | null {
    if (this.cachedToolDefs) return this.cachedToolDefs;
    const path = this.schemaCachePath;
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
        tools?: ToolDefinition[];
        // Daemon-mode cache writes ``mode: "daemon"``. Anything else
        // (or missing — pre-cutover cache files predate this field) is
        // treated as stale: the daemon adapter exposes a smaller surface
        // (no watchers, no research) and registering legacy tool names
        // would surface as "Unknown tool" errors at call time.
        mode?: "legacy" | "daemon";
        // Hash of the daemon's tool surface this cache was built under. Compared
        // against the live /healthz hash; a mismatch (or an older cache with no
        // hash at all) means the surface drifted and we must reprobe.
        toolsHash?: string;
      };
      const tools = parsed?.tools;
      if (!Array.isArray(tools) || tools.length === 0) return null;
      if (parsed.mode !== "daemon") {
        const label = parsed.mode ?? "pre-daemon (no mode field)";
        console.log(
          `[MANTLE] englyph schema cache is stale (${label}) — reprobing against daemon adapter`,
        );
        return null;
      }
      // Tool-surface drift: the daemon now advertises a different surface than the
      // cache was built under. Only enforced when the probe returned a usable hash
      // (an older daemon / failed import leaves daemonToolsHash null/"unknown" and
      // we keep trusting the cache). A hashless cache (parsed.toolsHash undefined)
      // mismatches any real hash → reprobes once, then records the hash going forward.
      if (
        this.daemonToolsHash &&
        this.daemonToolsHash !== "unknown" &&
        parsed.toolsHash !== this.daemonToolsHash
      ) {
        console.log(
          `[MANTLE] englyph schema cache is stale (tool-surface ${parsed.toolsHash ?? "unhashed"} → ${this.daemonToolsHash}) — reprobing`,
        );
        return null;
      }
      this.cachedToolDefs = tools;
      return tools;
    } catch (err) {
      console.warn(
        `[MANTLE] englyph schema cache unreadable, will reprobe: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  // Write the englyph tool defs to disk. Best-effort — failure logs
  // a warning but doesn't throw, since a missing cache just degrades
  // the next boot to a probe (not a hard failure).
  writeSchemaCache(tools: ToolDefinition[]): void {
    if (tools.length === 0) return;
    const path = this.schemaCachePath;
    const dir = resolve(path, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload = {
      capturedAt: new Date().toISOString(),
      mode: "daemon" as const,
      toolsHash: this.daemonToolsHash ?? undefined,
      tools,
    };
    try {
      writeFileSync(path, JSON.stringify(payload, null, 2), "utf-8");
      this.cachedToolDefs = tools;
    } catch (err) {
      console.warn(
        `[MANTLE] failed to write englyph schema cache: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Probe the daemon's /healthz endpoint with a short timeout. Returns
  // true if the daemon is up and responding. Called from bootstrapSchema
  // before any adapter spawn — fail-soft means a missing daemon disables
  // englyph for the session but mantle still boots cleanly.
  async probeDaemon(): Promise<boolean> {
    const url = `${this.daemonUrl}/healthz`;
    const timeoutMs =
      this.config.englyph.daemonProbeTimeoutMs ?? DEFAULT_DAEMON_PROBE_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) {
        console.warn(
          `[MANTLE] Englyph daemon at ${this.daemonUrl} returned ${resp.status} on /healthz — disabling englyph for this session`,
        );
        this.daemonReachable = false;
        return false;
      }
      const body = await resp.json().catch(() => null) as
        | { status?: string; embedder?: string; stores_open?: number; uptime_seconds?: number; tools_hash?: string }
        | null;
      this.daemonToolsHash = body?.tools_hash ?? null;
      const embedder = body?.embedder ?? "?";
      const open = body?.stores_open ?? 0;
      const upMin = body?.uptime_seconds ? Math.round(body.uptime_seconds / 60) : 0;
      console.log(
        `[MANTLE] Englyph daemon reachable at ${this.daemonUrl} (embedder=${embedder}, ${open} store${open === 1 ? "" : "s"} open, up ${upMin}m)`,
      );
      return true;
    } catch (err) {
      const reason = err instanceof Error && err.name === "AbortError"
        ? `timed out after ${timeoutMs}ms`
        : err instanceof Error ? err.message : String(err);
      console.warn(
        `[MANTLE] Englyph daemon unreachable at ${this.daemonUrl} (${reason}) — start it with \`python -m englyph_daemon\`. Mantle will run without memory for this session.`,
      );
      this.daemonReachable = false;
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // Boot-time entry point. Returns the englyph tool defs that can be
  // bridged into the registry. Probes the daemon /healthz first; if down,
  // disables englyph for the session (returns []). Tries the on-disk cache
  // next; on miss, spawns the default agent's adapter once to capture the
  // live tool surface, writes it to cache, and leaves that client warm so
  // the most-likely-first agent doesn't pay first-message latency.
  //
  // Returns [] when englyph is disabled, the daemon is unreachable, no
  // agents are configured, or the probe fails — bridgeEnglyphTools() then
  // registers nothing and downstream callers (memory.ts wrappers, async
  // research tool) skip their `registry.has(...)` gates as they would
  // today.
  async bootstrapSchema(): Promise<ToolDefinition[]> {
    if (!this.config.englyph.enabled) return [];

    const reachable = await this.probeDaemon();
    if (!reachable) return [];

    const cached = this.loadSchemaCache();
    if (cached) {
      console.log(
        `[MANTLE] Englyph schema loaded from cache (${cached.length} tools, no adapter spawn at boot)`,
      );
      return cached;
    }

    const defaultId = this.config.defaultAgent || this.config.agents[0]?.id;
    const probeAgent = defaultId ? this.findAgent(defaultId) : this.config.agents[0];
    if (!probeAgent) {
      console.log("[MANTLE] Englyph bootstrap skipped: no agents configured");
      return [];
    }

    console.log(
      `[MANTLE] Englyph schema cache miss — probing ${probeAgent.id} to capture tool surface (kept warm)...`,
    );
    const client = await this.startForAgent(probeAgent);
    if (!client) {
      console.log("[MANTLE] Englyph probe failed — proceeding without englyph tool surface");
      return [];
    }
    return client.getToolDefinitions();
  }

  // Resolve an agent's Englyph data directory.
  //
  //   - explicit `agent.englyphPath` wins (with `~` expansion + relative-to-
  //     basePath fallback for non-absolute paths)
  //   - otherwise default to `~/.rev-mantle/englyph-<agentId>`, which
  //     guarantees newly-created agents get an isolated store without
  //     any extra wiring
  resolveEnglyphPath(agent: AgentConfig): string {
    const raw = agent.englyphPath ?? `~/.rev-mantle/englyph-${agent.id}`;
    if (raw.startsWith("~")) {
      return resolve(homedir(), raw.slice(raw.startsWith("~/") || raw.startsWith("~\\") ? 2 : 1));
    }
    if (!resolve(raw).startsWith("/") && !/^[A-Za-z]:/.test(raw)) {
      return resolve(this.basePath, raw);
    }
    return resolve(raw);
  }

  getClient(agentId: string): McpClient | undefined {
    return this.clients.get(agentId);
  }

  // Spawn the Englyph MCP adapter for one agent. Idempotent — returns the
  // existing client if already started, dedups concurrent first-spawn
  // requests via pendingStarts so two parallel callers don't launch two
  // adapter processes for the same agent. Returns null if englyph is
  // disabled globally, the daemon was unreachable at boot, or the
  // adapter process fails to come up (typically auth-file or env issue).
  async startForAgent(agent: AgentConfig): Promise<McpClient | null> {
    if (!this.config.englyph.enabled) return null;
    if (!this.daemonReachable) return null;
    const existing = this.clients.get(agent.id);
    if (existing) return existing;
    const failedAt = this.failedStarts.get(agent.id);
    if (failedAt && Date.now() - failedAt < EnglyphManager.START_RETRY_COOLDOWN_MS) {
      return null; // recent spawn failure — don't re-pay the handshake yet
    }
    const pending = this.pendingStarts.get(agent.id);
    if (pending) return pending;

    const promise = this._doStart(agent);
    this.pendingStarts.set(agent.id, promise);
    try {
      const client = await promise;
      if (client) this.failedStarts.delete(agent.id);
      else this.failedStarts.set(agent.id, Date.now());
      return client;
    } finally {
      this.pendingStarts.delete(agent.id);
    }
  }

  private async _doStart(agent: AgentConfig): Promise<McpClient | null> {
    const spawn = this.buildAdapterSpawnConfig(agent);

    // Make sure the per-agent data dir exists. The daemon resolves the
    // path to a store_id and will materialize the chroma tree on first
    // open (init=true), but the parent dir needs to exist or POST
    // /api/v1/stores returns 400 INVALID_STORE_PATH.
    const englyphPath = spawn.env.ENGLYPH_PATH!;
    if (!existsSync(englyphPath)) {
      mkdirSync(englyphPath, { recursive: true });
    }

    const client = new McpClient({
      name: `englyph:${agent.id}`,
      command: spawn.command,
      args: spawn.args,
      cwd: spawn.cwd,
      env: spawn.env,
    });

    // If the adapter process dies, drop the dead client from the live map
    // so the next call re-spawns instead of reusing a client whose every
    // request would hang to its timeout.
    client.onExit = () => {
      if (this.clients.get(agent.id) === client) this.clients.delete(agent.id);
    };

    try {
      await client.connect();
      this.clients.set(agent.id, client);
      // Opportunistic schema-cache populate: if we've never written the
      // cache (first lazy spawn after a fresh install, or user deleted
      // the cache file), capture this client's tool surface now.
      if (!this.cachedToolDefs) {
        const defs = client.getToolDefinitions();
        if (defs.length > 0) this.writeSchemaCache(defs);
      }
      console.log(
        `[MANTLE] Englyph adapter connected for ${agent.id} (${client.getToolDefinitions().length} tools, store path: ${englyphPath})`
      );
      return client;
    } catch (err) {
      console.log(
        `[MANTLE] Englyph adapter failed for ${agent.id}: ${err instanceof Error ? err.message : err}`
      );
      return null;
    }
  }

  async stopForAgent(agentId: string): Promise<void> {
    const client = this.clients.get(agentId);
    if (!client) return;
    await client.disconnect().catch(() => {});
    this.clients.delete(agentId);
  }

  async stopAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.disconnect().catch(() => {});
    }
    this.clients.clear();
  }
}

// Bridge Englyph's MCP tool surface into the registry once, with per-call
// agent routing AND lazy per-agent spawn. Each registered tool dispatches
// to the McpClient owned by `context.agentId`; if no client exists for
// that agent yet, the wrapper awaits manager.startForAgent() before
// executing — so the python process boots only on the first englyph tool
// call for each agent (chat turn, heartbeat tick, cron job, pre-inference
// memory pack — all entry points get this for free since they all route
// through registry.execute with a ToolContext).
//
// `toolDefs` is the cached or freshly-probed englyph tool surface from
// EnglyphManager.bootstrapSchema(). Bridging from defs (rather than a
// live client) lets us register the englyph_* tools at boot without
// keeping any python process alive.
//
// Returns the number of registered tool names. Idempotent against a fresh
// registry; if a tool already exists (core registration ran first) we skip
// it to preserve precedence.
export function bridgeEnglyphTools(
  manager: EnglyphManager,
  registry: ToolRegistry,
  toolDefs: ToolDefinition[],
): number {
  if (toolDefs.length === 0) {
    console.log("[MANTLE:mcp] No Englyph tool defs available — skipping englyph bridge");
    return 0;
  }

  let count = 0;

  for (const def of toolDefs) {
    const toolName = def.name;
    if (registry.has(toolName)) {
      console.log(`[MANTLE:mcp] Skipping ${toolName} (already registered)`);
      continue;
    }

    const tool: Tool = {
      name: toolName,
      description: def.description,
      inputSchema: def.inputSchema,
      source: "englyph",
      async execute(input: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> {
        const agentId = context?.agentId;
        if (!agentId) {
          // No agent context = an internal caller forgot to thread it.
          // We can't safely guess which englyph instance to hit; fail loud
          // so the bug surfaces in development rather than corrupting the
          // wrong store.
          return {
            content: `Englyph tool ${toolName} called without agentId in ToolContext — internal caller must pass context: { agentId }`,
            isError: true,
          };
        }
        let client = manager.getClient(agentId);
        if (!client) {
          // First englyph call for this agent since boot — start its
          // python process. startForAgent dedups concurrent callers so a
          // burst of parallel calls (e.g. memory pack's 12 batched
          // searches) only triggers one spawn.
          const agent = manager.findAgent(agentId);
          if (!agent) {
            return {
              content: `Englyph not available for agent "${agentId}" — agent not found in config`,
              isError: true,
            };
          }
          const spawned = await manager.startForAgent(agent);
          if (!spawned) {
            return {
              content: `Englyph failed to start for agent "${agentId}"`,
              isError: true,
            };
          }
          client = spawned;
        }
        try {
          const result = await client.callTool(def.name, input, { signal: context?.signal });
          return { content: result };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: `Englyph tool error (${def.name}): ${message}`, isError: true };
        }
      },
    };

    registry.register(tool);
    count++;
  }

  return count;
}
