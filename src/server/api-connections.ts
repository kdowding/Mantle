// GET /api/connections — one coherent "is my setup working" snapshot for the
// Connections settings tab. Aggregates the live health of the four subsystems
// a fresh user cares about: inference (configured backends), memory (Englyph
// daemon reachability), voice (sidecar), and local models (runtime). Read-only;
// computed fresh each call (Englyph does a real /healthz probe).

import type { MantleConfig } from "../config/schema.js";
import { CATALOG, configuredBackends } from "../agent/providers/catalog.js";
import type { EnglyphManager } from "../englyph/manager.js";
import type { VoiceManager } from "../voice/manager.js";
import type { LocalModelManager } from "../local/manager.js";
import { computeFeatureReadiness } from "./feature-readiness.js";
import { json } from "./api-helpers.js";

export interface ConnectionsDeps {
  englyphManager?: EnglyphManager;
  voiceManager?: VoiceManager;
  localModelManager?: LocalModelManager;
}

export async function handleConnectionsApi(config: MantleConfig, deps: ConnectionsDeps): Promise<Response> {
  const { englyphManager, voiceManager, localModelManager } = deps;

  const ready = configuredBackends(config, { localModelManager });

  let englyphReachable = false;
  if (config.englyph.enabled && englyphManager) {
    try {
      englyphReachable = await englyphManager.probeDaemon();
    } catch {
      englyphReachable = false;
    }
  }

  const voiceAlive = voiceManager?.isAlive() ?? false;
  const localHasBinary = localModelManager?.hasBinary() ?? false;
  const localModelCount = localModelManager?.listModelIds().length ?? 0;

  return json({
    providers: {
      ready: ready.length,
      total: CATALOG.length,
      backends: CATALOG.map((b) => ({
        id: b.id,
        label: b.label,
        configured: b.isConfigured(config, { localModelManager }),
      })),
    },
    englyph: {
      enabled: config.englyph.enabled,
      reachable: englyphReachable,
      daemonUrl: config.englyph.daemonUrl ?? "",
    },
    voice: {
      enabled: voiceManager?.isEnabled() ?? false,
      alive: voiceAlive,
    },
    local: {
      enabled: config.localModels.enabled,
      hasBinary: localHasBinary,
      models: localModelCount,
      activeModel: localModelManager?.status().activeModelId ?? null,
    },
    // The consolidated per-feature readiness model — the single source the UI
    // gates (mic / memory-pack / Call / music CC), the wizard, and the Features
    // panel all read so enforcement can't drift from the health shown here.
    features: computeFeatureReadiness(config, { englyphReachable, voiceAlive, localHasBinary, localModelCount }),
  });
}
