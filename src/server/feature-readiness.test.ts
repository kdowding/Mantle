// Locks the feature-readiness model — the single source of truth the UI gates,
// the wizard, and the Features panel all read. Guards two things: (1) the lean
// DEFAULT_CONFIG really does land every optional feature in a non-ready state on
// a fresh clone, and (2) the enabled(intent) vs ready(reality) split resolves to
// the right status as flags/keys/health flip.

import { describe, test, expect } from "bun:test";
import { DEFAULT_CONFIG, type MantleConfig } from "../config/schema.js";
import { computeFeatureReadiness, type FeatureHealth, type FeatureId } from "./feature-readiness.js";

const DEAD: FeatureHealth = {
  englyphReachable: false,
  voiceAlive: false,
  localHasBinary: false,
  localModelCount: 0,
};

function cfg(mut?: (c: MantleConfig) => void): MantleConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  mut?.(c);
  return c;
}

function pick(config: MantleConfig, health: FeatureHealth, id: FeatureId) {
  const f = computeFeatureReadiness(config, health).find((x) => x.id === id);
  if (!f) throw new Error(`no readiness for ${id}`);
  return f;
}

describe("feature readiness — lean defaults", () => {
  test("a fresh clone leaves every gated feature non-ready", () => {
    const features = computeFeatureReadiness(cfg(), DEAD);
    for (const f of features) expect(f.ready).toBe(false);
  });

  test("flag-gated features report off (not needs_setup) when never enabled", () => {
    const c = cfg();
    for (const id of ["memory", "voice", "stt", "ttsChatterbox", "realtime", "localModels", "music"] as FeatureId[]) {
      expect(pick(c, DEAD, id).status).toBe("off");
    }
  });

  test("xAI TTS has no flag — it reports needs_key until a Grok key exists", () => {
    expect(pick(cfg(), DEAD, "ttsXai").status).toBe("needs_key");
  });
});

describe("feature readiness — memory", () => {
  test("enabled + reachable → ready", () => {
    const c = cfg((x) => { x.englyph.enabled = true; });
    expect(pick(c, { ...DEAD, englyphReachable: true }, "memory").status).toBe("ready");
  });

  test("enabled + daemon down → needs_setup with a hint", () => {
    const c = cfg((x) => { x.englyph.enabled = true; });
    const f = pick(c, DEAD, "memory");
    expect(f.status).toBe("needs_setup");
    expect(f.ready).toBe(false);
    expect(f.setupHint).toBeTruthy();
  });
});

describe("feature readiness — voice sidecar drives chatterbox + STT", () => {
  test("voice on + sidecar alive → voice, chatterbox, and stt all ready", () => {
    const c = cfg((x) => { x.voice.enabled = true; });
    const health = { ...DEAD, voiceAlive: true };
    for (const id of ["voice", "ttsChatterbox", "stt"] as FeatureId[]) {
      expect(pick(c, health, id).status).toBe("ready");
    }
  });

  test("voice on + sidecar down → the same three are needs_setup, not off", () => {
    const c = cfg((x) => { x.voice.enabled = true; });
    for (const id of ["voice", "ttsChatterbox", "stt"] as FeatureId[]) {
      expect(pick(c, DEAD, id).status).toBe("needs_setup");
    }
  });
});

describe("feature readiness — key-gated", () => {
  test("Grok key flips ttsXai ready and realtime (when enabled) ready", () => {
    const c = cfg((x) => { x.realtime.enabled = true; x.providers.grok.apiKey = "xai-test"; });
    expect(pick(c, DEAD, "ttsXai").status).toBe("ready");
    expect(pick(c, DEAD, "realtime").status).toBe("ready");
  });

  test("realtime enabled without a key → needs_key", () => {
    const c = cfg((x) => { x.realtime.enabled = true; });
    expect(pick(c, DEAD, "realtime").status).toBe("needs_key");
  });
});

describe("feature readiness — local models", () => {
  test("enabled, no binary → needs_setup (distinct 'binary missing' detail)", () => {
    const c = cfg((x) => { x.localModels.enabled = true; });
    const f = pick(c, DEAD, "localModels");
    expect(f.status).toBe("needs_setup");
    expect(f.detail).toContain("binary");
  });

  test("enabled, binary present, no models → needs_setup (distinct 'no models' detail)", () => {
    const c = cfg((x) => { x.localModels.enabled = true; });
    const f = pick(c, { ...DEAD, localHasBinary: true }, "localModels");
    expect(f.status).toBe("needs_setup");
    expect(f.detail).toContain("no models");
  });

  test("enabled, binary + a model → ready", () => {
    const c = cfg((x) => { x.localModels.enabled = true; });
    expect(pick(c, { ...DEAD, localHasBinary: true, localModelCount: 1 }, "localModels").status).toBe("ready");
  });
});

describe("feature readiness — music player vs generation", () => {
  test("enabled without a key → needs_key (player works, generation doesn't)", () => {
    const c = cfg((x) => { x.music.enabled = true; });
    expect(pick(c, DEAD, "music").status).toBe("needs_key");
  });

  test("enabled with a key → ready", () => {
    const c = cfg((x) => { x.music.enabled = true; x.music.apiKey = "kie-test"; });
    expect(pick(c, DEAD, "music").status).toBe("ready");
  });
});
