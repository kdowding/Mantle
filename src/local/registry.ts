/**
 * Local-model registry — the source of truth for which GGUF models exist
 * locally and their per-model llama.cpp spawn overrides.
 *
 * Lives at `<modelsDir>/registry.json` (default `./local/registry.json`).
 * Written by `mantle pull` (CLI, possibly while the server is down) and by
 * the REST settings endpoints (server up). Read by:
 *   - boot, to seed `config.providers.local.{models,defaultModel}` so the
 *     runtime model-lookup paths (ws / cron / heartbeat) resolve a valid id;
 *   - the LocalModelManager, for per-model spawn settings;
 *   - the REST layer, live, so a model pulled while the server is up shows
 *     up without a restart.
 *
 * Deliberately dependency-free (fs/path only) so the CLI can use it without
 * dragging in the server.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { isAbsolute, resolve } from "path";

export interface LocalModelEntry {
  /** User-facing model id. Also the `model` string sent to llama-server
   *  (which ignores it — one model per process — but it keeps transcripts
   *  and the UI selector readable). Unique within the registry. */
  id: string;
  /** GGUF filename relative to `<modelsDir>/models/`, or an absolute path.
   *  For multi-part (`*-00001-of-0000N.gguf`) models this is the FIRST
   *  part — llama.cpp loads the rest automatically. */
  file: string;
  /** Display name for the UI. Falls back to `id`. */
  name?: string;
  /** Where it came from (HF repo id or full URL) — provenance for the UI. */
  source?: string;
  /** Quantization tag, e.g. "Q4_K_M". */
  quant?: string;
  /** On-disk size in bytes (sum of all parts), for the UI. */
  sizeBytes?: number;

  // ── Per-model spawn overrides (fall back to config.localModels.defaults) ──
  /** -c / --ctx-size. 0 = model's trained context. (spawn-time — reload) */
  ctxSize?: number;
  /** -ngl / --n-gpu-layers. -1 = offload all, 0 = CPU only. (reload) */
  gpuLayers?: number;
  /** --threads. 0 = llama.cpp auto. (reload) */
  threads?: number;
  /** KV-cache data type → --cache-type-k/v. f16 | q8_0 | q4_0. (reload) */
  kvCacheType?: "f16" | "q8_0" | "q4_0";
  /** Flash attention → -fa. auto | on | off. Forced on when KV quantized. (reload) */
  flashAttn?: "auto" | "on" | "off";
  /** Which tools to advertise: "off" | "core" (curated ~14) | "all" |
   *  "custom" (exactly the names in `allowedTools`). Per-request (no reload).
   *  Undefined = config default ("core"). */
  toolMode?: "off" | "core" | "all" | "custom";
  /** Explicit tool allow-list for toolMode "custom" — only these tool names
   *  are advertised. Lets you trim to e.g. just read_file to save context on
   *  small models. Ignored unless toolMode is "custom". */
  allowedTools?: string[];
  /** Legacy on/off tool gate, kept for back-compat: false maps to
   *  toolMode "off" when toolMode is unset. Prefer toolMode. */
  supportsTools?: boolean;
  /** Sampling overrides (per-request, no reload). Undefined = config
   *  default for that knob. */
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  /** Max generated tokens per turn. 0 = uncapped. */
  maxTokens?: number;
  /** Emits chain-of-thought (DeepSeek-R1 / Qwen3 / QwQ). Drives the UI
   *  thinking hint AND enables inline `<think>…</think>` parsing in the
   *  provider (the modern `reasoning_content` path is always handled). */
  reasoning?: boolean;
  /** Optional chat-template override → llama-server `--chat-template`. */
  chatTemplate?: string;

  /** ISO timestamp the model was pulled/registered. */
  pulledAt?: string;
}

export interface LocalRegistry {
  version: 1;
  /** Default model id for the local provider. */
  defaultModelId?: string;
  models: LocalModelEntry[];
}

const REGISTRY_BASENAME = "registry.json";

function emptyRegistry(): LocalRegistry {
  return { version: 1, models: [] };
}

/** Resolve `modelsDir` (relative → against `basePath`) to an absolute path. */
export function resolveModelsDir(basePath: string, modelsDir: string): string {
  return isAbsolute(modelsDir) ? modelsDir : resolve(basePath, modelsDir);
}

/** Absolute path to the weights subdirectory (`<modelsDir>/models`). */
export function modelsWeightsDir(modelsDirAbs: string): string {
  return resolve(modelsDirAbs, "models");
}

export function registryPath(modelsDirAbs: string): string {
  return resolve(modelsDirAbs, REGISTRY_BASENAME);
}

/** Read the registry. Returns an empty registry if the file is missing or
 *  unparseable (a corrupt file shouldn't take down boot). */
export function loadRegistry(modelsDirAbs: string): LocalRegistry {
  const path = registryPath(modelsDirAbs);
  if (!existsSync(path)) return emptyRegistry();
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<LocalRegistry>;
    return {
      version: 1,
      defaultModelId: raw.defaultModelId,
      models: Array.isArray(raw.models) ? (raw.models as LocalModelEntry[]) : [],
    };
  } catch (err) {
    console.warn(
      `[MANTLE:local] registry.json unreadable (${err instanceof Error ? err.message : err}) — treating as empty`,
    );
    return emptyRegistry();
  }
}

/** Persist the registry, creating `<modelsDir>` if needed. */
export function saveRegistry(modelsDirAbs: string, reg: LocalRegistry): void {
  if (!existsSync(modelsDirAbs)) mkdirSync(modelsDirAbs, { recursive: true });
  writeFileSync(registryPath(modelsDirAbs), JSON.stringify(reg, null, 2), "utf-8");
}

export function getModel(reg: LocalRegistry, id: string): LocalModelEntry | undefined {
  return reg.models.find((m) => m.id === id);
}

/** Absolute path to a model's first GGUF part. */
export function resolveModelFile(modelsDirAbs: string, entry: LocalModelEntry): string {
  return isAbsolute(entry.file) ? entry.file : resolve(modelsWeightsDir(modelsDirAbs), entry.file);
}

/**
 * Insert or replace a model entry (matched by id) and persist. If the
 * registry had no default, the new model becomes it. Returns the saved
 * registry.
 */
export function upsertModel(modelsDirAbs: string, entry: LocalModelEntry): LocalRegistry {
  const reg = loadRegistry(modelsDirAbs);
  const idx = reg.models.findIndex((m) => m.id === entry.id);
  if (idx >= 0) reg.models[idx] = { ...reg.models[idx], ...entry };
  else reg.models.push(entry);
  if (!reg.defaultModelId) reg.defaultModelId = entry.id;
  saveRegistry(modelsDirAbs, reg);
  return reg;
}

/**
 * Merge a partial settings patch into an existing model entry. No-op (returns
 * undefined) if the id isn't found. Repairs the default pointer if asked.
 */
export function updateModel(
  modelsDirAbs: string,
  id: string,
  patch: Partial<Omit<LocalModelEntry, "id">> & { makeDefault?: boolean },
): LocalModelEntry | undefined {
  const reg = loadRegistry(modelsDirAbs);
  const entry = reg.models.find((m) => m.id === id);
  if (!entry) return undefined;
  const { makeDefault, ...fields } = patch;
  Object.assign(entry, fields);
  if (makeDefault) reg.defaultModelId = id;
  saveRegistry(modelsDirAbs, reg);
  return entry;
}

/**
 * Clear a model's per-knob overrides so it falls back to config defaults.
 * Resets only fields that HAVE a `config.localModels.defaults` counterpart
 * (sampling + spawn + toolMode); leaves model traits (reasoning, supportsTools,
 * chatTemplate) and identity (id/file/name/source/quant/sizeBytes/pulledAt)
 * intact. Returns the updated entry, or undefined if the id isn't found.
 */
export function resetModelOverrides(modelsDirAbs: string, id: string): LocalModelEntry | undefined {
  const reg = loadRegistry(modelsDirAbs);
  const entry = reg.models.find((m) => m.id === id);
  if (!entry) return undefined;
  for (const k of [
    "ctxSize", "gpuLayers", "threads", "toolMode",
    "temperature", "topP", "topK", "minP", "repeatPenalty", "maxTokens",
    "kvCacheType", "flashAttn",
  ] as const) {
    delete entry[k];
  }
  saveRegistry(modelsDirAbs, reg);
  return entry;
}

/**
 * Remove a model from the registry. Returns the removed entry (or undefined).
 * Does NOT delete the GGUF file — the caller decides (the CLI/REST layer
 * passes the path to unlink when the user asks).
 */
export function removeModel(modelsDirAbs: string, id: string): LocalModelEntry | undefined {
  const reg = loadRegistry(modelsDirAbs);
  const idx = reg.models.findIndex((m) => m.id === id);
  if (idx < 0) return undefined;
  const [removed] = reg.models.splice(idx, 1);
  if (reg.defaultModelId === id) reg.defaultModelId = reg.models[0]?.id;
  saveRegistry(modelsDirAbs, reg);
  return removed;
}
