import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "fs";
import { resolve, basename } from "path";
import { type MantleConfig, type AgentConfig, DEFAULT_CONFIG, CONFIG_VERSION, HEAVY_FEATURES } from "./schema.js";
import { migrateLegacyBackendId } from "../agent/providers/backend-ids.js";

const MANTLE_DIR = ".mantle";
const CONFIG_FILE = "config.json";

// Keys that must never be merged from parsed JSON — assigning them on a
// plain object mutates the prototype chain (prototype pollution). JSON.parse
// only produces own-enumerable __proto__ via crafted input, but config.json
// is user-editable and REST-writable, so refuse them structurally.
const FORBIDDEN_MERGE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_MERGE_KEYS.has(key)) continue;
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

// Preserve an unparseable config.json before anything overwrites or
// defaults past it — a torn write losing the whole agent/provider setup
// silently is far worse than a stray backup file.
function preserveCorruptConfig(configPath: string): void {
  try {
    const backup = `${configPath}.corrupt-${Date.now()}`;
    copyFileSync(configPath, backup);
    console.error(`[MANTLE:config] preserved unparseable config as ${basename(backup)}`);
  } catch {
    // best effort
  }
}

export function loadConfig(basePath: string): MantleConfig {
  const mantleDir = resolve(basePath, MANTLE_DIR);
  const configPath = resolve(mantleDir, CONFIG_FILE);

  // Ensure .mantle directory exists
  if (!existsSync(mantleDir)) {
    mkdirSync(mantleDir, { recursive: true });
  }

  // Load config file if it exists, merge with defaults
  const fileExisted = existsSync(configPath);
  let fileConfig: Partial<MantleConfig> & { workspace?: string } = {};
  let parsedOk = false;
  if (fileExisted) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      fileConfig = JSON.parse(raw);
      parsedOk = true;
    } catch (err) {
      console.error(`[MANTLE:config] Failed to parse ${configPath}:`, err);
      preserveCorruptConfig(configPath);
    }
  }

  // Merge into a CLONE of DEFAULT_CONFIG, never the singleton: deepMerge shallow-
  // copies, so any subtree the file doesn't override would otherwise be a shared
  // reference to DEFAULT_CONFIG — and later in-place writes (env key fill, the
  // feature migration below) would silently mutate the global default for every
  // subsequent load. Harmless with one load per process; corrupting across loads.
  const config = deepMerge(structuredClone(DEFAULT_CONFIG), fileConfig) as MantleConfig;

  // Env keys are a FALLBACK, not an override. config.json wins so the in-app
  // options screen stays the ONE editable source of truth — a key set in the
  // UI can't be silently clobbered by a stale env var on the next load. Env
  // still fills any provider whose config key is empty, so Docker / CI /
  // secrets-manager workflows keep working. Precedence: config.json > env.
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey && !config.providers.claude.apiKey) {
    config.providers.claude.apiKey = anthropicKey;
  }

  const xaiKey = process.env.XAI_API_KEY;
  if (xaiKey && !config.providers.grok.apiKey) {
    config.providers.grok.apiKey = xaiKey;
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey && !config.providers.openai.apiKey) {
    config.providers.openai.apiKey = openaiKey;
  }

  // kie.ai key for music generation (Suno) — same fallback rule as above.
  const kieKey = process.env.KIE_API_KEY;
  if (kieKey && !config.music.apiKey) {
    config.music.apiKey = kieKey;
  }

  // Store resolved base path
  config.basePath = resolve(basePath);

  // ── Backward compat: migrate single workspace → agents[] ──────────────
  // Only when the target workspace actually EXISTS — a legacy single-workspace
  // install. On a fresh clone there's no workspace yet, so synthesizing a
  // "default" agent here would just get dropped by the missing-workspace check
  // below, logging a scary "workspace directory not found" warning on every
  // first boot. Leave agents empty instead; the UI onboarding creates the first.
  if (config.agents.length === 0) {
    const workspacePath = config.workspace
      ? resolve(basePath, config.workspace)
      : resolve(basePath, "workspaces", "default");

    if (existsSync(workspacePath)) {
      const agentId = basename(workspacePath);
      config.agents = [{
        id: agentId,
        name: agentId.charAt(0).toUpperCase() + agentId.slice(1),
        workspace: workspacePath,
      }];
      config.defaultAgent = agentId;
      console.log(`[MANTLE:config] Migrated single workspace to agent: ${agentId}`);
    }
  }

  // Resolve all agent workspace paths to absolute
  for (const agent of config.agents) {
    agent.workspace = resolve(basePath, agent.workspace);
  }

  // Resolve global skills dir
  config.globalSkillsDir = resolve(basePath, config.globalSkillsDir);

  // ── Drop agents whose workspace is missing ────────────────────────────
  // An agent entry in config.json with no workspace folder on disk would
  // half-load: skills/avatar lookups fail, the system prompt is just the
  // default header, etc. Skip them with a warning so the runtime stays
  // coherent. The user can either restore the folder or remove the entry.
  const validAgents: AgentConfig[] = [];
  for (const agent of config.agents) {
    if (!existsSync(agent.workspace)) {
      console.warn(
        `[MANTLE:config] Skipping agent "${agent.id}" — workspace directory not found: ${agent.workspace}`
      );
      continue;
    }
    validAgents.push(agent);
  }
  config.agents = validAgents;

  // Set default agent if not set or if the configured default was dropped
  if (!config.defaultAgent || !config.agents.find((a) => a.id === config.defaultAgent)) {
    config.defaultAgent = config.agents[0]?.id ?? "";
  }

  // Calm first-run note instead of a warning — zero agents is the expected
  // fresh-clone state; the UI onboarding panel walks the user through creating one.
  if (config.agents.length === 0) {
    console.log("[MANTLE:config] No agents yet — create your first one in the UI (onboarding panel).");
  }

  // Ensure session directories exist per agent
  for (const agent of config.agents) {
    const agentSessionsDir = resolve(mantleDir, "sessions", agent.id);
    if (!existsSync(agentSessionsDir)) {
      mkdirSync(agentSessionsDir, { recursive: true });
    }
  }

  // ── Preserve feature behavior across the lean-defaults change ─────────────
  // Lean defaults (voice/englyph/realtime/localModels/music → off) are for FRESH
  // clones. A config FILE that predates the change omits those flags and was
  // implicitly ON, so deepMerge would now flip them off and silently drop the
  // user's voice/memory/music on upgrade. A file with no configVersion is
  // pre-lean: fill any OMITTED feature flag with its old default (true), leave
  // explicit choices (incl. an intentional false) alone, then stamp the version
  // so this runs once. saveConfig stamps configVersion on every write, so a
  // fresh/lean config is never mistaken for a pre-lean one. (fileConfig is the
  // original parse, so this fires correctly even if a save ran above.)
  // Only a SUCCESSFULLY-PARSED file with no configVersion is a pre-lean config. A
  // corrupt/unparseable file (parsedOk=false, fileConfig still {}) must NOT be
  // treated as one — migrating it would force every heavy feature on AND write a
  // fresh config, the opposite of the lean intent and the corrupt-preservation
  // contract (which is meant to default past a torn file, writing nothing).
  if (fileExisted && parsedOk && typeof fileConfig.configVersion === "undefined") {
    const omits = (sec: unknown): boolean =>
      !sec || typeof sec !== "object" || typeof (sec as { enabled?: unknown }).enabled === "undefined";
    for (const f of HEAVY_FEATURES) {
      if (!omits((fileConfig as Record<string, any>)[f])) continue;
      // Coalesce a non-object slot (e.g. a hand-written `"voice": null`, which
      // deepMerge propagates as `config.voice === null`) to a real section before
      // the write, so a malformed value degrades instead of crashing boot —
      // matching the saveConfig updater's own guard below.
      const slot = config[f] as unknown;
      if (!slot || typeof slot !== "object") (config as Record<string, any>)[f] = structuredClone(DEFAULT_CONFIG[f]);
      config[f].enabled = true;
    }
    config.configVersion = CONFIG_VERSION;
    try {
      saveConfig(basePath, (raw) => {
        for (const f of HEAVY_FEATURES) {
          if (omits(raw[f])) raw[f] = { ...(raw[f] && typeof raw[f] === "object" ? raw[f] : {}), enabled: true };
        }
        // configVersion is stamped by saveConfig itself.
      });
      console.log("[MANTLE:config] Migrated pre-lean config — preserved enabled features, stamped configVersion.");
    } catch { /* in-memory migration already applied; persist is best-effort */ }
  }

  // ── Migrate provider VALUES to composite backend ids ──────────────────────
  // The resolver + UI accept legacy names, but normalizing the stored config
  // keeps it consistent with the (vendor × mode) catalog. Covers the global
  // default AND each agent's defaultProvider, persisted in one pass (best-effort)
  // so config.json self-heals. migrateLegacyBackendId is idempotent (composite
  // ids pass through), so this is a no-op once migrated. (The heartbeat
  // provider override stays legacy — deliberately not migrated here.)
  let providerValuesMigrated = false;

  const migratedDefault = migrateLegacyBackendId(config.defaultProvider);
  if (migratedDefault !== config.defaultProvider) {
    config.defaultProvider = migratedDefault;
    providerValuesMigrated = true;
  }

  for (const agent of config.agents) {
    if (!agent.defaultProvider) continue;
    const migrated = migrateLegacyBackendId(agent.defaultProvider);
    if (migrated !== agent.defaultProvider) {
      agent.defaultProvider = migrated;
      providerValuesMigrated = true;
    }
  }

  if (providerValuesMigrated) {
    try {
      saveConfig(basePath, (raw) => {
        if (typeof raw.defaultProvider === "string") {
          raw.defaultProvider = migrateLegacyBackendId(raw.defaultProvider);
        }
        if (Array.isArray(raw.agents)) {
          for (const a of raw.agents) {
            if (a && typeof a.defaultProvider === "string") {
              a.defaultProvider = migrateLegacyBackendId(a.defaultProvider);
            }
          }
        }
      });
    } catch { /* in-memory migration already applied; persist is best-effort */ }
  }

  return config;
}

// Helper to find an agent config by ID
export function getAgent(config: MantleConfig, agentId: string): AgentConfig | undefined {
  return config.agents.find((a) => a.id === agentId);
}

// Save config changes to disk. The updater receives the raw JSON object
// (with relative paths intact) and mutates it in place. Atomic (tmp +
// rename) so a crash mid-write can't leave a torn config.json that the
// next loadConfig silently defaults past. The read-modify-write body is
// synchronous — single-tick, so concurrent REST writers can't interleave.
export function saveConfig(basePath: string, updater: (raw: Record<string, any>) => void): void {
  const mantleDir = resolve(basePath, MANTLE_DIR);
  const configPath = resolve(mantleDir, CONFIG_FILE);

  let raw: Record<string, any> = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      // Unparseable — keep a copy before the rewrite below replaces it.
      preserveCorruptConfig(configPath);
    }
  }

  updater(raw);
  // Stamp the schema version on every write so a config touched after the
  // lean-defaults change is never mis-read as pre-lean by loadConfig's migration.
  raw.configVersion = CONFIG_VERSION;
  const tmp = `${configPath}.tmp`;
  // 0600 — config.json holds provider API keys, so keep it owner-only at rest
  // (POSIX; Windows ACLs ignore the mode). The rename carries the tmp's perms
  // onto config.json, so a previously world-readable file gets tightened too.
  writeFileSync(tmp, JSON.stringify(raw, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, configPath);
}

// Read the raw on-disk config.json (pre-merge, pre-env-fill) or null if absent
// / unparseable. Used to attribute a provider key's SOURCE — a key present in
// the file is config-sourced; one present only in env is env-sourced. The
// merged in-memory config can't tell the two apart (env fills empty slots).
export function readRawConfig(basePath: string): Record<string, any> | null {
  const configPath = resolve(resolve(basePath, MANTLE_DIR), CONFIG_FILE);
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
  } catch {
    return null;
  }
}
