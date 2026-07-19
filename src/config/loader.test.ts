// Locks the lean-defaults migration: fresh clones boot lean, but an existing
// config that predates the change (no configVersion) keeps the features it had
// — an upgrade must never silently drop a user's voice/memory/music. The
// configVersion marker is what tells a pre-lean config apart from a fresh/lean
// one that intentionally omits a flag, so saveConfig stamps it on every write.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { loadConfig, saveConfig, readRawConfig } from "./loader.js";
import { CONFIG_VERSION } from "./schema.js";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mantle-loader-"));
  mkdirSync(join(base, ".mantle"), { recursive: true });
});

const writeConfig = (obj: unknown): void =>
  writeFileSync(join(base, ".mantle", "config.json"), JSON.stringify(obj), "utf-8");
const configPath = (): string => resolve(base, ".mantle", "config.json");
const LEAN = ["voice", "englyph", "realtime", "localModels", "music"] as const;
const enabledOf = (c: Record<string, any>, k: string): boolean => c[k].enabled;

describe("fresh clone — lean defaults", () => {
  test("no config file → every heavy feature off, cron on, nothing written", () => {
    const c = loadConfig(base);
    for (const k of LEAN) expect(enabledOf(c, k)).toBe(false);
    expect(c.cron.enabled).toBe(true);
    expect(c.configVersion).toBe(CONFIG_VERSION);
    expect(existsSync(configPath())).toBe(false); // migration skipped; no spurious write
  });
});

describe("pre-lean migration (existing config, no configVersion)", () => {
  test("omitted feature flags are restored to on and persisted + stamped", () => {
    writeConfig({ music: { apiKey: "" } }); // a real file, no version, no enabled flags
    const c = loadConfig(base);
    for (const k of LEAN) expect(enabledOf(c, k)).toBe(true);

    const raw = readRawConfig(base);
    expect(raw?.configVersion).toBe(CONFIG_VERSION);
    expect(raw?.voice?.enabled).toBe(true);
    expect(raw?.music?.enabled).toBe(true);
  });

  test("an explicit false is a deliberate choice — preserved, not flipped on", () => {
    writeConfig({ voice: { enabled: false } });
    const c = loadConfig(base);
    expect(c.voice.enabled).toBe(false); // kept
    expect(c.englyph.enabled).toBe(true); // omitted → restored
    expect(c.configVersion).toBe(CONFIG_VERSION);
  });

  test("idempotent — once stamped, a later explicit off is respected on reload", () => {
    writeConfig({ music: { apiKey: "" } });
    loadConfig(base); // migrates + stamps
    saveConfig(base, (raw) => { raw.voice = { enabled: false }; }); // stamps version too
    expect(loadConfig(base).voice.enabled).toBe(false); // not re-flipped on
  });
});

describe("lean-aware config (post-lean, has configVersion)", () => {
  test("an omitted flag stays lean — the migration does not fire", () => {
    writeConfig({ configVersion: CONFIG_VERSION, music: { apiKey: "" } });
    const c = loadConfig(base);
    expect(c.voice.enabled).toBe(false);
    expect(c.englyph.enabled).toBe(false);
  });
});

describe("saveConfig", () => {
  test("stamps configVersion on every write", () => {
    saveConfig(base, (raw) => { raw.music = { apiKey: "k" }; });
    expect(readRawConfig(base)?.configVersion).toBe(CONFIG_VERSION);
  });
});

describe("malformed configs degrade instead of force-enabling or crashing", () => {
  test("a corrupt config.json is NOT migrated — features stay lean, file not rewritten", () => {
    writeFileSync(configPath(), "{ this is not valid json", "utf-8");
    const c = loadConfig(base);
    for (const k of LEAN) expect(enabledOf(c, k)).toBe(false); // not force-enabled
    // The migration must not fire on an unparseable file: the corrupt content is
    // preserved (backed up) and left in place, never overwritten with a migrated
    // {voice:{enabled:true},…} config.
    expect(readFileSync(configPath(), "utf-8")).toBe("{ this is not valid json");
  });

  test("a feature key explicitly null degrades (coalesced + migrated) instead of crashing boot", () => {
    writeConfig({ voice: null }); // deepMerge yields config.voice === null
    const c = loadConfig(base); // pre-fix this threw "null is not an object"
    expect(c.voice.enabled).toBe(true); // coalesced to a real section, migrated on
    expect(c.englyph.enabled).toBe(true);
    expect(c.configVersion).toBe(CONFIG_VERSION);
  });
});
