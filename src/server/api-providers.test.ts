// Provider API-key management: source attribution (config vs env vs none),
// leak-safe persistence (saveConfig writes only what the updater sets, never
// env-baked values), 0600 at rest, and the PUT handler's clear / error paths.
// The set-with-validation path makes a real network probe, so it's covered by
// the M4 UI e2e rather than here.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { saveConfig, readRawConfig } from "../config/loader.js";
import { providerKeyStates, validateProviderKey, handleProvidersApi } from "./api-providers.js";
import type { MantleConfig } from "../config/schema.js";

let base: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY", "KIE_API_KEY"];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mantle-prov-"));
  mkdirSync(join(base, ".mantle"), { recursive: true });
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function minimalConfig(): MantleConfig {
  return {
    providers: { claude: { apiKey: "" }, openai: { apiKey: "" }, grok: { apiKey: "" } },
    music: { apiKey: "" },
  } as unknown as MantleConfig;
}
const putReq = (body: unknown): Request =>
  new Request("http://x/api/config/providers", { method: "PUT", body: JSON.stringify(body) });
const u = (): URL => new URL("http://x/api/config/providers");

describe("providerKeyStates", () => {
  test("none when neither config nor env has a key", () => {
    const s = providerKeyStates(base);
    expect(s.claude).toEqual({ set: false, source: "none" });
    expect(s.openai.set).toBe(false);
    expect(s.grok.source).toBe("none");
  });

  test("config-sourced when the file holds a key", () => {
    saveConfig(base, (raw) => { raw.providers = { claude: { apiKey: "sk-ant-x" } }; });
    expect(providerKeyStates(base).claude).toEqual({ set: true, source: "config" });
  });

  test("env-sourced when only env holds a key", () => {
    process.env.XAI_API_KEY = "xai-x";
    expect(providerKeyStates(base).grok).toEqual({ set: true, source: "env" });
  });

  test("config wins over env for source attribution", () => {
    saveConfig(base, (raw) => { raw.providers = { openai: { apiKey: "sk-cfg" } }; });
    process.env.OPENAI_API_KEY = "sk-env";
    expect(providerKeyStates(base).openai).toEqual({ set: true, source: "config" });
  });

  test("the music (kie.ai) key tracks config.music.apiKey, not providers.*", () => {
    expect(providerKeyStates(base).music).toEqual({ set: false, source: "none" });
    saveConfig(base, (raw) => { raw.music = { apiKey: "kie-x" }; });
    expect(providerKeyStates(base).music).toEqual({ set: true, source: "config" });
  });

  test("the music key is env-sourced when only KIE_API_KEY is set", () => {
    process.env.KIE_API_KEY = "kie-env";
    expect(providerKeyStates(base).music).toEqual({ set: true, source: "env" });
  });
});

describe("saveConfig key write (leak-safe + 0600)", () => {
  test("persists only the updater's key — an env key never leaks to disk", () => {
    process.env.ANTHROPIC_API_KEY = "sk-env-leak";
    saveConfig(base, (raw) => {
      raw.providers = { ...raw.providers, grok: { apiKey: "xai-cfg" } };
    });
    const raw = readRawConfig(base);
    expect(raw?.providers?.grok?.apiKey).toBe("xai-cfg");
    expect(raw?.providers?.claude?.apiKey).toBeUndefined();
  });

  test("config.json is written 0600 (POSIX)", () => {
    saveConfig(base, (raw) => { raw.providers = { claude: { apiKey: "x" } }; });
    const file = resolve(base, ".mantle", "config.json");
    expect(existsSync(file)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});

describe("validateProviderKey", () => {
  test("empty key is rejected without a network call", async () => {
    expect(await validateProviderKey("claude", "")).toEqual({ ok: false, error: "empty key" });
  });
});

describe("handleProvidersApi", () => {
  test("rejects non-PUT", async () => {
    const res = await handleProvidersApi(new Request("http://x/api/config/providers"), u(), minimalConfig(), base);
    expect(res.status).toBe(405);
  });

  test("rejects an unknown vendor", async () => {
    const res = await handleProvidersApi(putReq({ vendor: "gemini", apiKey: "x" }), u(), minimalConfig(), base);
    expect(res.status).toBe(400);
  });

  test("clear persists empty + falls back to env in memory", async () => {
    process.env.OPENAI_API_KEY = "sk-env";
    const config = minimalConfig();
    const res = await handleProvidersApi(putReq({ vendor: "openai", apiKey: "" }), u(), config, base);
    const data = (await res.json()) as { ok: boolean; set: boolean; source: string };
    expect(data.ok).toBe(true);
    expect(data.source).toBe("env");
    expect(data.set).toBe(true);
    expect(config.providers.openai.apiKey).toBe("sk-env"); // in-memory fell back to env
    expect(readRawConfig(base)?.providers?.openai?.apiKey).toBe(""); // file cleared
  });

  test("clear with no env leaves it unset", async () => {
    const config = minimalConfig();
    const res = await handleProvidersApi(putReq({ vendor: "grok", apiKey: "" }), u(), config, base);
    const data = (await res.json()) as { set: boolean; source: string };
    expect(data.set).toBe(false);
    expect(data.source).toBe("none");
    expect(config.providers.grok.apiKey).toBe("");
  });

  test("the music key writes config.music.apiKey, unverified, without touching providers", async () => {
    const config = minimalConfig();
    const res = await handleProvidersApi(putReq({ vendor: "music", apiKey: "kie-abc" }), u(), config, base);
    const data = (await res.json()) as { ok: boolean; set: boolean; source: string; validation: unknown };
    expect(data.ok).toBe(true);
    expect(data.set).toBe(true);
    expect(data.source).toBe("config");
    expect(data.validation).toBeNull(); // no provider probe for the kie.ai key
    expect(config.music.apiKey).toBe("kie-abc"); // live config updated
    expect(readRawConfig(base)?.music?.apiKey).toBe("kie-abc"); // persisted
    expect(readRawConfig(base)?.providers).toBeUndefined(); // providers untouched
  });

  test("clearing the music key falls back to KIE_API_KEY in the live config", async () => {
    process.env.KIE_API_KEY = "kie-env";
    const config = minimalConfig();
    const res = await handleProvidersApi(putReq({ vendor: "music", apiKey: "" }), u(), config, base);
    const data = (await res.json()) as { set: boolean; source: string };
    expect(data.set).toBe(true);
    expect(data.source).toBe("env");
    expect(config.music.apiKey).toBe("kie-env"); // in-memory fell back to env
    expect(readRawConfig(base)?.music?.apiKey).toBe(""); // file cleared
  });
});
