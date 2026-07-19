/**
 * Provider backend catalog — the single source of truth for what an agent can
 * talk to. Each entry is one vendor/access-mode cell backed by an in-process
 * `Provider`; the agent loop owns tool execution and iteration for every entry.
 *
 * The catalog unifies selection, dispatch, and capability/config reporting.
 * Composite ids ("vendor/mode") are the stable wire/storage value, while old
 * flat names migrate via LEGACY_BACKEND_IDS.
 *
 * This is the live factory: nothing is constructed at boot; every dispatch
 * site builds a Provider here per turn via resolveProviderTurn → makeProvider.
 */

import type { MantleConfig } from "../../config/schema.js";
import type { Provider } from "./types.js";
import type { LocalModelManager } from "../../local/manager.js";

import { ClaudeProvider } from "./claude.js";
import { GrokProvider } from "./grok.js";
import { OpenAICodexProvider } from "./openai-codex.js";
import { OpenAiProvider } from "./openai.js";
import { GrokBuildProvider } from "./grok-build.js";
import { LocalProvider } from "./local.js";
import { loadCodexTokens } from "../../auth/openai-codex.js";
import { loadGrokCliTokens, loadMantleGrokTokens } from "../../auth/grok-build.js";
import {
  type Vendor,
  type Mode,
  type BackendId,
  VENDOR_LABELS,
  migrateLegacyBackendId,
} from "./backend-ids.js";

// Backend identity moved to backend-ids.ts (no provider-SDK imports, so the
// loader + CLI can use it). Re-exported so `… from "./catalog.js"` still
// works. (LEGACY_BACKEND_IDS itself is internal to backend-ids — import it
// from there if a future caller needs the raw map.)
export { VENDOR_LABELS, migrateLegacyBackendId };
export type { Vendor, Mode, BackendId };

// Runtime deps a backend may need beyond static config (the local backend owns
// a live llama-server via the manager; others ignore it).
export interface BackendDeps {
  localModelManager?: LocalModelManager;
}

interface BackendBase {
  id: BackendId;
  vendor: Vendor;
  mode: Mode;
  label: string;
  /** Model ids this backend can run (live for local; static config elsewhere). */
  models(config: MantleConfig, deps?: BackendDeps): string[];
  /** Preferred model when the caller doesn't specify one. */
  defaultModel(config: MantleConfig, deps?: BackendDeps): string | undefined;
  /** Usable right now? (key present / token present / model registered) */
  isConfigured(config: MantleConfig, deps?: BackendDeps): boolean;
}

export interface BackendEntry extends BackendBase {
  makeProvider(config: MantleConfig, deps?: BackendDeps): Provider;
}

export const CATALOG: BackendEntry[] = [
  {
    id: "anthropic/api",
    vendor: "anthropic",
    mode: "api",
    label: "Claude · API",
    models: (c) => c.providers.claude.models,
    defaultModel: (c) => c.providers.claude.defaultModel,
    isConfigured: (c) => !!c.providers.claude.apiKey,
    makeProvider: (c) => {
      if (!c.providers.claude.apiKey) {
        throw new Error("Claude API key not configured. Set ANTHROPIC_API_KEY or add to .mantle/config.json");
      }
      return new ClaudeProvider(c.providers.claude.apiKey);
    },
  },
  {
    id: "openai/subscription",
    vendor: "openai",
    mode: "subscription",
    label: "ChatGPT · Codex",
    models: (c) => c.providers["openai-codex"].models,
    defaultModel: (c) => c.providers["openai-codex"].defaultModel,
    isConfigured: (c) => !!loadCodexTokens(c.basePath),
    makeProvider: (c) => new OpenAICodexProvider(c.basePath),
  },
  {
    id: "openai/api",
    vendor: "openai",
    mode: "api",
    label: "ChatGPT · API",
    models: (c) => c.providers.openai.models,
    defaultModel: (c) => c.providers.openai.defaultModel,
    isConfigured: (c) => !!c.providers.openai.apiKey,
    makeProvider: (c) => {
      if (!c.providers.openai.apiKey) {
        throw new Error("ChatGPT API key not configured. Set OPENAI_API_KEY or add to .mantle/config.json");
      }
      return new OpenAiProvider(c.providers.openai.apiKey);
    },
  },
  {
    id: "xai/api",
    vendor: "xai",
    mode: "api",
    label: "Grok · API",
    models: (c) => c.providers.grok.models,
    defaultModel: (c) => c.providers.grok.defaultModel,
    isConfigured: (c) => !!c.providers.grok.apiKey,
    makeProvider: (c) => {
      if (!c.providers.grok.apiKey) {
        throw new Error("Grok API key not configured. Set XAI_API_KEY or add to .mantle/config.json");
      }
      return new GrokProvider(c.providers.grok.apiKey);
    },
  },
  {
    id: "xai/subscription",
    vendor: "xai",
    mode: "subscription",
    label: "Grok · Build",
    models: (c) => c.providers["grok-build"].models,
    defaultModel: (c) => c.providers["grok-build"].defaultModel,
    // Either store works: the grok CLI's own cache, or mantle's refreshed copy
    // (which can outlive the CLI store — refresh tokens rotate single-use).
    isConfigured: (c) => !!loadGrokCliTokens() || !!loadMantleGrokTokens(c.basePath),
    makeProvider: (c) => new GrokBuildProvider(c.basePath),
  },
  {
    id: "local",
    vendor: "local",
    mode: "local",
    label: "Local",
    models: (_c, deps) => deps?.localModelManager?.listModelIds() ?? [],
    defaultModel: (_c, deps) => deps?.localModelManager?.getDefaultModelId() ?? undefined,
    isConfigured: (c, deps) =>
      c.localModels.enabled && (deps?.localModelManager?.listModelIds().length ?? 0) > 0,
    makeProvider: (_c, deps) => {
      if (!deps?.localModelManager) {
        throw new Error("Local backend requires a LocalModelManager (not wired).");
      }
      return new LocalProvider(deps.localModelManager);
    },
  },
];

export function getBackend(id: string): BackendEntry | undefined {
  return CATALOG.find((b) => b.id === id);
}

/** All backends usable right now (key/token/model present). */
export function configuredBackends(config: MantleConfig, deps?: BackendDeps): BackendEntry[] {
  return CATALOG.filter((b) => b.isConfigured(config, deps));
}

// ── Turn resolution ─────────────────────────────────────────────────────────

// The inputs every dispatch site has when it needs to pick a backend: an
// optional explicit choice for this turn, the agent's defaults, and the global
// default. Provider/model fields accept legacy flat names ("grok") OR composite
// ids ("xai/api") — migration runs inside resolveProviderTurn, so callers don't
// care which they hold (eases the eventual SessionMeta.backendId switch).
export interface ProviderSelection {
  requestedProvider?: string;
  requestedModel?: string;
  agentDefaultProvider?: string;
  agentDefaultModel?: string;
  globalDefaultProvider: string;
}

export type ResolvedProvider =
  | { ok: true; provider: Provider; model: string; backendId: BackendId; vendor: Vendor }
  | { ok: false; error: string };

/**
 * Resolve a turn to a constructed Provider + model. This is the
 * single home for the three selection rules that used to be duplicated (and,
 * outside chat, silently missing) across ws.ts and the heartbeat/cron/
 * background/subagent runners:
 *
 *   1. legacy-name migration — "grok" → "xai/api", etc. (composite ids pass
 *      through unchanged).
 *   2. grok-build model routing — the model id "grok-build" appears inside the
 *      Grok model dropdown for UX, but it's a different backend (OAuth via
 *      ~/.grok, Responses proxy). Picking it routes to xai/subscription
 *      regardless of which Grok-family provider was active.
 *   3. local-model fallback — when the turn didn't name a model and the
 *      inherited default isn't a valid local id, fall back to the local
 *      registry's default rather than handing llama-server a Claude/Grok id.
 *
 * Returns the built Provider on success, or { ok:false, error } the caller
 * surfaces in its own idiom. makeProvider may throw (e.g. missing API key) —
 * that becomes a branded error string here.
 */
export function resolveProviderTurn(
  config: MantleConfig,
  deps: BackendDeps,
  sel: ProviderSelection,
): ResolvedProvider {
  const name = sel.requestedProvider ?? sel.agentDefaultProvider ?? sel.globalDefaultProvider;
  const effectiveModel = sel.requestedModel ?? sel.agentDefaultModel;

  // (1) migrate legacy name → composite id, then (2) the grok-build override.
  let backendId = migrateLegacyBackendId(name);
  if (effectiveModel === "grok-build") backendId = "xai/subscription";

  const backend = getBackend(backendId);
  if (!backend) return { ok: false, error: `Provider not available: ${name}` };

  let model = effectiveModel ?? backend.defaultModel(config, deps);

  // (3) local-model fallback — only when the turn didn't explicitly pick one.
  if (backend.vendor === "local" && !sel.requestedModel) {
    const localIds = backend.models(config, deps);
    if (!model || !localIds.includes(model)) {
      model = backend.defaultModel(config, deps) ?? localIds[0] ?? model;
    }
  }

  if (!model) return { ok: false, error: `No model resolved for ${backend.id}` };

  try {
    const provider = backend.makeProvider(config, deps);
    return { ok: true, provider, model, backendId: backend.id, vendor: backend.vendor };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
