// Feature flag write path: only known features, boolean-only, persisted to disk
// AND mirrored onto the live config (so the readiness model reflects it without
// a reload), and configVersion gets stamped by saveConfig along the way.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readRawConfig } from "../config/loader.js";
import { handleFeaturesApi } from "./api-features.js";
import { CONFIG_VERSION, HEAVY_FEATURES } from "../config/schema.js";
import type { MantleConfig } from "../config/schema.js";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mantle-feat-"));
  mkdirSync(join(base, ".mantle"), { recursive: true });
});

function cfg(): MantleConfig {
  return {
    voice: { enabled: false }, englyph: { enabled: false }, realtime: { enabled: false },
    localModels: { enabled: false }, music: { enabled: false }, cron: { enabled: true },
  } as unknown as MantleConfig;
}
const putReq = (body: unknown): Request =>
  new Request("http://x/api/config/features", { method: "PUT", body: JSON.stringify(body) });

describe("handleFeaturesApi", () => {
  test("rejects non-PUT", async () => {
    const res = await handleFeaturesApi(new Request("http://x/api/config/features"), cfg(), base);
    expect(res.status).toBe(405);
  });

  test("rejects an unknown feature", async () => {
    const res = await handleFeaturesApi(putReq({ feature: "telepathy", enabled: true }), cfg(), base);
    expect(res.status).toBe(400);
  });

  test("rejects a non-boolean enabled", async () => {
    const res = await handleFeaturesApi(putReq({ feature: "voice", enabled: "yes" }), cfg(), base);
    expect(res.status).toBe(400);
  });

  test("enabling a feature persists it, mirrors the live config, stamps the version", async () => {
    const config = cfg();
    const res = await handleFeaturesApi(putReq({ feature: "englyph", enabled: true }), config, base);
    const data = (await res.json()) as { ok: boolean; feature: string; enabled: boolean };
    expect(data).toEqual({ ok: true, feature: "englyph", enabled: true });
    expect(config.englyph.enabled).toBe(true); // live config mirrored
    expect(readRawConfig(base)?.englyph?.enabled).toBe(true); // persisted
    expect(readRawConfig(base)?.configVersion).toBe(CONFIG_VERSION); // stamped by saveConfig
  });

  test("disabling a feature writes false (not just absence)", async () => {
    const config = cfg();
    config.music.enabled = true;
    await handleFeaturesApi(putReq({ feature: "music", enabled: false }), config, base);
    expect(config.music.enabled).toBe(false);
    expect(readRawConfig(base)?.music?.enabled).toBe(false);
  });

  test("every feature in the canonical HEAVY_FEATURES list is accepted", async () => {
    for (const f of HEAVY_FEATURES) {
      const res = await handleFeaturesApi(putReq({ feature: f, enabled: true }), cfg(), base);
      expect(res.status).toBe(200);
    }
  });

  test("cron is NOT toggleable here — it's not a heavy opt-in feature", async () => {
    const res = await handleFeaturesApi(putReq({ feature: "cron", enabled: false }), cfg(), base);
    expect(res.status).toBe(400); // dropped from TOGGLEABLE; the four lists agree
  });
});
