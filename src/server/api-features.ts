// Feature enable/disable — the write side for the heavy, optional subsystems
// (voice / englyph / realtime / localModels / music / cron). The setup wizard's
// "pick your features" step and the Features settings panel both PUT here. The
// flag is persisted (saveConfig stamps configVersion) and applied to the live
// config so the readiness model + UI gates pick it up immediately. Process START
// for the subsystem-backed ones (voice sidecar, Englyph bridge, cron runner) still
// needs a restart — the readiness model surfaces "on, not set up yet" until then.

import { type MantleConfig, HEAVY_FEATURES, type HeavyFeature } from "../config/schema.js";
import { saveConfig } from "../config/loader.js";
import { json, readJsonBody } from "./api-helpers.js";

// The toggleable set IS the heavy-feature set (one source — see schema.ts). `cron`
// is intentionally absent: it's zero-setup, defaults on, and has no readiness row
// or UI toggle, so accepting it here would be a write-only orphan.
export type ToggleableFeature = HeavyFeature;
const TOGGLEABLE: readonly ToggleableFeature[] = HEAVY_FEATURES;

function isToggleable(v: unknown): v is ToggleableFeature {
  return typeof v === "string" && (TOGGLEABLE as readonly string[]).includes(v);
}

// PUT /api/config/features  { feature, enabled }  — flip one subsystem's master flag.
export async function handleFeaturesApi(
  req: Request,
  config: MantleConfig,
  basePath: string,
): Promise<Response> {
  if (req.method !== "PUT") return json({ error: "Method not allowed" }, 405);

  let body: { feature?: unknown; enabled?: unknown } | null;
  try {
    body = (await readJsonBody(req)) as { feature?: unknown; enabled?: unknown } | null;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const feature = body?.feature;
  if (!isToggleable(feature)) {
    return json({ error: `feature must be one of: ${TOGGLEABLE.join(", ")}` }, 400);
  }
  if (typeof body?.enabled !== "boolean") {
    return json({ error: "enabled must be a boolean" }, 400);
  }
  const enabled = body.enabled;

  // Persist to the on-disk file (atomic; stamps configVersion), then mirror onto
  // the live config so /api/connections readiness + the UI gates reflect it now.
  saveConfig(basePath, (raw) => {
    if (!raw[feature] || typeof raw[feature] !== "object") raw[feature] = {};
    raw[feature].enabled = enabled;
  });
  config[feature].enabled = enabled;

  return json({ ok: true, feature, enabled });
}
