// The INTEGRATION contract — the formalization of "an integration is just a
// function with a description, fronted by auth."
//
// Sibling to the Room contract (src/rooms/types.ts), and deliberately NOT a
// Room: integrations are MANY (one per external service) and share a uniform
// auth/connection lifecycle that rooms don't have. What they share with rooms
// is the bolt-on discipline — register at the composition root, participate in
// agent purge + footprint, deletable as a directory + a registration line.
//
// Two backing implementations behind one concept:
//   - NATIVE (default): tools() returns Tools whose execute() calls the
//     service's official SDK with a broker-minted token. Gets mantle's
//     hardening, tool classification, concurrency, and a CURATED surface.
//   - MCP (escape hatch): mcp() returns a server spec the registry bridges
//     lazily-per-agent with a fresh token in env (the Englyph adapter pattern,
//     NOT the global+eager config.mcp.servers path — that can't carry a
//     refreshing token). For the long tail you don't want to hand-write.
// The model can't tell the two apart — both surface as named JSON-schema
// tools it invokes identically.
//
// Direction rules (to be enforced by scripts/check-arch.ts, mirroring rooms):
//   - integrations/ MAY import core (agent/ tools/ config/ auth/ voice/ local/)
//     but NEVER src/server — the server composes per-agent tool visibility and
//     owns the generic REST surface; capabilities are injected at construction.
//   - core (agent/ tools/ cron/) NEVER imports integrations/. The composition
//     root (src/index.ts) and the server layer are the only referrers.

import type { Tool } from "../tools/types.js";

// ---- Auth ------------------------------------------------------------------

// What the broker needs to run an integration's authorization + token
// lifecycle. The user's OWN OAuth-app client id/secret are NOT here — they're
// read from config.integrations.<id> at runtime, so no secret ever lives in
// code and the OSS repo ships none. This declares the flow SHAPE; the broker
// (src/auth/oauth-broker.ts, a generalization of auth/openai-codex.ts) runs it.
export type IntegrationAuth =
  | { kind: "none" }
  | {
      // User pastes a long-lived token (e.g. a GitHub fine-grained PAT). No
      // browser dance; stored as-is, never refreshed.
      kind: "pat";
      label?: string; // UI hint, e.g. "GitHub personal access token"
    }
  | {
      kind: "oauth2";
      authorizeUrl: string;
      tokenUrl: string;
      // Default-granted on connect, read-only. The companion lives here.
      readScopes: string[];
      // Opt-in, write/exfil-capable (send mail, push, delete). NOT requested
      // unless the user explicitly enables write for THIS (agent,integration).
      writeScopes?: string[];
      // PKCE public-client flow (no client secret) where the provider allows.
      usePkce?: boolean;
      // Device-authorization grant — no redirect URI to pre-register, user
      // pastes a code. Preferred for headless / remote (Tailscale) hosts where
      // a localhost callback can't be reached.
      deviceAuthorizeUrl?: string;
      // Extra provider-specific authorize-URL params (e.g. Google's
      // access_type=offline + prompt=consent to guarantee a refresh token).
      // Kept generic so the broker needs no per-vendor branches.
      extraAuthParams?: Record<string, string>;
    };

// Stored connection metadata for one (integration, agent) pair. null from the
// broker means "not connected". Lives in the broker's token store
// (.mantle/auth/integrations/<agentId>/<integrationId>.json, 0600) — NOT in
// config.json, so tokens stay out of the REST-writable config.
export interface IntegrationConnectionInfo {
  account?: string; // human label of the connected account, e.g. "kyle@gmail.com"
  scopes: string[];
  writeEnabled: boolean;
  expiresAt?: number; // ms epoch; broker refreshes before this
}

// The port an integration's tools depend on for a fresh, per-agent token at
// execute() time. Consumer-defined (declared here, implemented in src/auth)
// so integrations couple only to this shape, not the broker's innards. Keyed
// by (integrationId, agentId); refresh + single-use-rotation dedup are the
// broker's job — see auth/openai-codex.ts for the single-provider prototype.
export interface TokenBroker {
  // Fresh access token for this agent's connection, refreshing if near expiry.
  // Throws if the agent hasn't connected this integration.
  getAccessToken(integrationId: string, agentId: string): Promise<string>;
  // Sync read of stored connection metadata. null === not connected. Covers
  // both visibility gating (below) and the UI status surface in one call.
  connectionInfo(integrationId: string, agentId: string): IntegrationConnectionInfo | null;
}

// ---- Purge / footprint (independent of the Room equivalents — siblings must
// not depend on each other) ------------------------------------------------

export interface IntegrationFootprintSection {
  label: string;
  path?: string;
  exists: boolean;
  note?: string;
}

export interface IntegrationPurgeResult {
  ok: boolean;
  detail?: string;
}

// Per-agent connection status for the UI / footprint.
export interface IntegrationStatus {
  integrationId: string;
  label: string;
  connected: boolean;
  account?: string;
  scopes?: string[];
  writeEnabled?: boolean;
  expiresAt?: number;
}

// Escape-hatch spec: back an integration with an off-the-shelf MCP server. The
// registry spawns it lazily per agent with a broker-minted token substituted
// into env (any value of "{{token}}" is replaced at spawn). Mutually exclusive
// with tools().
export interface IntegrationMcpSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

// ---- The contract ----------------------------------------------------------

export interface Integration {
  // Stable id — "github" / "gmail" / "outlook". Namespaces tools
  // (source: "integration:<id>") and keys the broker's token store.
  id: string;
  label: string;

  // The authorization shape the broker runs. The integration DECLARES it; the
  // broker EXECUTES it. Client id/secret come from config, not from here.
  auth: IntegrationAuth;

  // Validate a freshly-supplied credential (a PAT now; an OAuth result later)
  // and report what it grants — called by the connect flow BEFORE the broker
  // stores it, so a bad token fails loudly and the account label + write-scope
  // are captured up front. Optional; omit to store unverified.
  verifyToken?(token: string): Promise<IntegrationConnectionInfo>;

  // Native agent-facing tools (the default path). Called once at boot and
  // registered globally, stamped source:"integration:<id>". Each tool's
  // execute() pulls its token via the broker + context.agentId, so the SAME
  // registered tool serves every agent with that agent's own credentials.
  // Per-agent VISIBILITY is applied later at surface-build time — see
  // IntegrationRegistry.hiddenToolNames(). Omit when backing via mcp().
  tools?(): Tool[];

  // Names of this integration's tools that MUTATE or exfil (send, push,
  // delete). Enforced two ways for this injectable companion: (1) hidden from
  // an agent's chat surface unless the connection holds write scope (see
  // hiddenToolNames), and (2) guarded at EXECUTION by the registry
  // (guardWriteTool) — they refuse unless write scope is granted, AND refuse in
  // autonomous (scheduled/cron) runs unless MANTLE_ALLOW_AUTONOMOUS_WRITES=1.
  // Read tools need no entry. NOTE: in interactive chat a write tool the user
  // has granted scope for is NOT confirmation-gated per call — the call is
  // visible in the UI as it runs, but an injection could fire it before the
  // user reacts; granting write scope is the trust boundary.
  writeTools?: string[];

  // Escape hatch (see IntegrationMcpSpec). Mutually exclusive with tools().
  mcp?(): IntegrationMcpSpec;

  // Integration-specific REST (e.g. inbound webhooks). The GENERIC connect /
  // disconnect / oauth-callback / status routes are owned by the registry's
  // /api/integrations/* surface — most integrations omit this.
  restPrefix?: string;
  handleApi?(req: Request, url: URL): Promise<Response>;

  // Drop EXTRA per-agent state this integration cached (upstream webhooks,
  // local sync data). The broker's tokens for (id, agentId) are revoked +
  // deleted by the registry itself; this hook is for everything else. Must be
  // safe to call for unknown ids.
  onAgentPurge(agentId: string): Promise<IntegrationPurgeResult>;

  // Purge preview, like the room footprint.
  footprint?(agentId: string): IntegrationFootprintSection[];

  start?(): void;
  stop?(): void | Promise<void>;
}

// ---- Registry --------------------------------------------------------------

// Boot builds one registry (mirroring RoomRegistry): the composition root
// registers integrations + their native tools, the server dispatches the
// generic + per-integration REST, and purge / footprint iterate it. The one
// thing rooms don't need: per-agent tool VISIBILITY, exposed via
// hiddenToolNames() for the server to fold into the chat toolFilter (the
// server may import integrations; the agent loop must not — so the gate is
// composed at the server layer, never inside core).
export class IntegrationRegistry {
  private integrations: Integration[] = [];
  // Tool names cached at register() so visibility gating doesn't re-run each
  // integration's tools() factory every turn.
  private toolNames = new Map<string, string[]>();

  constructor(private broker: TokenBroker) {}

  register(integration: Integration): void {
    this.integrations.push(integration);
    this.toolNames.set(integration.id, (integration.tools?.() ?? []).map((t) => t.name));
  }

  list(): Integration[] {
    return [...this.integrations];
  }

  get(id: string): Integration | undefined {
    return this.integrations.find((i) => i.id === id);
  }

  // Every native tool across integrations, for one-time global registration at
  // the composition root (the caller stamps source, mirroring rooms). Write/exfil
  // tools are wrapped with a broker-backed scope guard (see guardWriteTool) so the
  // write-scope check is enforced at EXECUTION — not only by the per-agent
  // advertisement filter the server folds in via hiddenToolNames(). The
  // advertisement filter keeps an unscoped write tool out of the chat surface,
  // but it doesn't cover the cron/triggered surface (composed in core, which
  // can't import integrations) and can't stop a prompt-injected model from
  // emitting a hidden tool's name directly. The guard closes both paths.
  tools(): Tool[] {
    return this.integrations.flatMap((i) => {
      const writeNames = new Set(i.writeTools ?? []);
      return (i.tools?.() ?? []).map((t) =>
        writeNames.has(t.name) ? this.guardWriteTool(i.id, t) : t,
      );
    });
  }

  // Wrap a mutating/exfil tool so its execute() refuses unless the calling
  // agent's connection actually holds write scope — AND refuses in autonomous
  // runs by default. Defense-in-depth for an injectable single-user companion:
  // even if the tool reaches dispatch (a companion cron preset advertising the
  // full surface, or an injected tool-name emission), it can't send/push/delete
  // on a read-only connection, and an unattended (injected) cron run can't use
  // it at all unless the operator explicitly opted in.
  private guardWriteTool(integrationId: string, tool: Tool): Tool {
    return {
      ...tool,
      execute: async (input, context) => {
        const agentId = context?.agentId;
        const info = agentId ? this.broker.connectionInfo(integrationId, agentId) : null;
        if (!info || !info.writeEnabled) {
          return {
            content: `"${tool.name}" needs write access for the ${integrationId} connection, which is not enabled for this agent. Connect ${integrationId} with write scope in Settings → Connections to use it.`,
            isError: true,
          };
        }
        // Autonomous (scheduled/cron) runs have no human watching, so an
        // injected unattended run is the highest-risk path for a write/exfil
        // tool. Default-deny; require an explicit operator opt-in.
        if (context?.autonomous && process.env.MANTLE_ALLOW_AUTONOMOUS_WRITES !== "1") {
          return {
            content: `"${tool.name}" is a write/exfil tool and is disabled in autonomous (scheduled) runs by default — no human is present to vet it. Set MANTLE_ALLOW_AUTONOMOUS_WRITES=1 to allow write tools in cron jobs.`,
            isError: true,
          };
        }
        return tool.execute(input, context);
      },
    };
  }

  // Tool names to HIDE from a given agent's surface: every integration tool
  // whose integration that agent hasn't connected, plus write tools when the
  // connection lacks write scope. The server merges this into the per-turn
  // toolFilter / disabledTools so an agent only carries tools it can actually
  // use — which also keeps the per-turn tool payload small.
  hiddenToolNames(agentId: string): string[] {
    const hidden: string[] = [];
    for (const integration of this.integrations) {
      const names = this.toolNames.get(integration.id) ?? [];
      if (names.length === 0) continue;
      const info = this.broker.connectionInfo(integration.id, agentId);
      if (!info) {
        hidden.push(...names);
        continue;
      }
      if (!info.writeEnabled && integration.writeTools?.length) {
        hidden.push(...integration.writeTools);
      }
    }
    return hidden;
  }

  // Per-agent connection status for the UI.
  status(agentId: string): IntegrationStatus[] {
    return this.integrations.map((integration) => {
      const info = this.broker.connectionInfo(integration.id, agentId);
      return {
        integrationId: integration.id,
        label: integration.label,
        connected: !!info,
        account: info?.account,
        scopes: info?.scopes,
        writeEnabled: info?.writeEnabled,
        expiresAt: info?.expiresAt,
      };
    });
  }

  // Per-integration custom REST (webhooks). Returns null when no integration
  // owns the path — the generic /api/integrations/* surface lives elsewhere.
  async dispatchApi(req: Request, url: URL): Promise<Response | null> {
    for (const integration of this.integrations) {
      if (!integration.restPrefix || !integration.handleApi) continue;
      if (
        url.pathname.startsWith(integration.restPrefix) ||
        url.pathname === integration.restPrefix.replace(/\/$/, "")
      ) {
        return integration.handleApi(req, url);
      }
    }
    return null;
  }

  // Run every integration's purge hook; failures are reported, never thrown —
  // one integration's failure must not strand the rest of the purge.
  async purgeAgent(agentId: string): Promise<Array<{ integration: string; ok: boolean; detail?: string }>> {
    const results: Array<{ integration: string; ok: boolean; detail?: string }> = [];
    for (const integration of this.integrations) {
      try {
        const r = await integration.onAgentPurge(agentId);
        results.push({ integration: integration.id, ok: r.ok, detail: r.detail });
      } catch (err) {
        results.push({
          integration: integration.id,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  footprint(agentId: string): Array<{ integration: string; sections: IntegrationFootprintSection[] }> {
    const out: Array<{ integration: string; sections: IntegrationFootprintSection[] }> = [];
    for (const integration of this.integrations) {
      if (!integration.footprint) continue;
      try {
        out.push({ integration: integration.id, sections: integration.footprint(agentId) });
      } catch {
        out.push({ integration: integration.id, sections: [] });
      }
    }
    return out;
  }

  startAll(): void {
    for (const integration of this.integrations) {
      try {
        integration.start?.();
      } catch (err) {
        console.warn(`[MANTLE:integrations] ${integration.id}.start() threw: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const integration of this.integrations) {
      try {
        await integration.stop?.();
      } catch (err) {
        console.warn(`[MANTLE:integrations] ${integration.id}.stop() threw: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
