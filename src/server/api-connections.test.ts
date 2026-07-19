// Locks the GLUE between the connections probes and the readiness model: that
// handleConnectionsApi threads englyphReachable / voiceAlive / localHasBinary /
// localModelCount into the right FeatureHealth fields. The pure computation is
// covered in feature-readiness.test.ts; this catches a wrong-probe wiring (e.g.
// voiceAlive ↔ localHasBinary swapped) that the pure test can't see.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleConnectionsApi, type ConnectionsDeps } from "./api-connections.js";
import type { MantleConfig } from "../config/schema.js";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mantle-conn-"));
  mkdirSync(join(base, ".mantle"), { recursive: true });
});

function cfg(): MantleConfig {
  return {
    basePath: base,
    providers: { claude: { apiKey: "" }, openai: { apiKey: "" }, grok: { apiKey: "" }, local: { models: [] } },
    englyph: { enabled: true }, voice: { enabled: true }, realtime: { enabled: true },
    localModels: { enabled: true }, music: { enabled: true, apiKey: "" },
  } as unknown as MantleConfig;
}

function deps(o: { englyphReachable: boolean; voiceAlive: boolean; hasBinary: boolean; models: string[] }): ConnectionsDeps {
  return {
    englyphManager: { probeDaemon: async () => o.englyphReachable },
    voiceManager: { isEnabled: () => true, isAlive: () => o.voiceAlive },
    localModelManager: {
      hasBinary: () => o.hasBinary,
      listModelIds: () => o.models,
      status: () => ({ activeModelId: o.models[0] ?? null }),
    },
  } as unknown as ConnectionsDeps;
}

const feat = (body: { features: { id: string }[] }, id: string) =>
  body.features.find((f) => f.id === id) as { id: string; ready: boolean; status: string; detail: string };

describe("handleConnectionsApi → readiness glue", () => {
  test("healthy probes thread through to the right features + model count", async () => {
    const res = await handleConnectionsApi(cfg(), deps({ englyphReachable: true, voiceAlive: true, hasBinary: true, models: ["m1", "m2"] }));
    const body = (await res.json()) as { features: { id: string }[] };
    expect(feat(body, "voice").ready).toBe(true);   // voiceAlive →
    expect(feat(body, "stt").ready).toBe(true);     // shares the sidecar
    expect(feat(body, "memory").ready).toBe(true);  // englyphReachable →
    expect(feat(body, "localModels").status).toBe("ready"); // hasBinary + count>0
    expect(feat(body, "localModels").detail).toContain("2 model"); // localModelCount →
  });

  test("down probes surface needs_setup — no field swap masking it as ready", async () => {
    const res = await handleConnectionsApi(cfg(), deps({ englyphReachable: false, voiceAlive: false, hasBinary: false, models: [] }));
    const body = (await res.json()) as { features: { id: string }[] };
    expect(feat(body, "voice").status).toBe("needs_setup");
    expect(feat(body, "memory").status).toBe("needs_setup");
    expect(feat(body, "localModels").status).toBe("needs_setup");
  });
});
