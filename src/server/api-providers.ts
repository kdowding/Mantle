// Provider API-key management — the write side of /api/config. Lets the
// authenticated user set/clear Anthropic / OpenAI / xAI keys from the options
// screen (the one editable source of truth; env stays a fallback). Keys are
// WRITE-ONLY over the wire: they come IN here, and GET /api/config only ever
// reports presence + source, never the value.
//
// Leak-safe persistence: saveConfig() mutates the ON-DISK config.json, not the
// env-baked in-memory config — so an env-provided key is never written into the
// file. The in-memory config is updated separately so the running server picks
// up the change without a restart (the catalog reads it live, per turn).

import type { MantleConfig } from "../config/schema.js";
import { saveConfig, readRawConfig } from "../config/loader.js";
import { json, readJsonBody } from "./api-helpers.js";
import { setUserName } from "../agent/prompt-builder.js";

export type KeyVendor = "claude" | "openai" | "grok";
// The music (kie.ai) key isn't a catalog inference provider — it lives at
// config.music.apiKey, not config.providers.* — but it rides the same write
// path + Providers-tab row, so it's a fourth key TARGET alongside the three.
export type KeyTarget = KeyVendor | "music";

const ENV_VAR: Record<KeyTarget, string> = {
  claude: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  grok: "XAI_API_KEY",
  music: "KIE_API_KEY",
};

const VALIDATE: Record<KeyVendor, { url: string; headers: (k: string) => Record<string, string> }> = {
  claude: {
    url: "https://api.anthropic.com/v1/models",
    headers: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }),
  },
  openai: {
    url: "https://api.openai.com/v1/models",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  grok: {
    url: "https://api.x.ai/v1/models",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
};

export interface KeyValidation {
  ok: boolean;
  error?: string;
}

// Cheap authenticated probe: GET the vendor's /models with the candidate key.
// 200 = valid; 401/403 = rejected (distinct message so the UI can say "bad key"
// vs "couldn't verify"); anything else / network error = unverified.
export async function validateProviderKey(vendor: KeyVendor, apiKey: string): Promise<KeyValidation> {
  if (!apiKey) return { ok: false, error: "empty key" };
  const ep = VALIDATE[vendor];
  try {
    const res = await fetch(ep.url, { headers: ep.headers(apiKey), signal: AbortSignal.timeout(8000) });
    if (res.ok) return { ok: true };
    // A valid key always 200s on /models, so any 4xx on our well-formed request
    // means the key won't work — auth (401/403) or, for xAI, a 400 on a bad /
    // malformed key. The exception is 429: a valid key that's just rate-limited.
    if (res.status === 429) return { ok: false, error: "rate limited — could not verify, try again" };
    if (res.status >= 400 && res.status < 500) return { ok: false, error: "key rejected by provider" };
    return { ok: false, error: `provider error (HTTP ${res.status})` };
  } catch (e) {
    return { ok: false, error: `could not reach provider (${e instanceof Error ? e.message : String(e)})` };
  }
}

export interface KeyState {
  set: boolean;
  source: "config" | "env" | "none";
}

// Per-vendor presence + source, read fresh from disk + env so the options
// screen can show "set (options)" vs "set (env: VAR)" vs "not set". The merged
// in-memory config can't distinguish the two (env fills empty slots), so source
// is attributed from the on-disk file. Never returns key values.
export function providerKeyStates(basePath: string): Record<KeyTarget, KeyState> {
  const raw = readRawConfig(basePath);
  const mk = (inFile: boolean, envVar: string): KeyState => {
    const inEnv = !!process.env[envVar];
    return { set: inFile || inEnv, source: inFile ? "config" : inEnv ? "env" : "none" };
  };
  return {
    claude: mk(!!raw?.providers?.claude?.apiKey, ENV_VAR.claude),
    openai: mk(!!raw?.providers?.openai?.apiKey, ENV_VAR.openai),
    grok: mk(!!raw?.providers?.grok?.apiKey, ENV_VAR.grok),
    // The kie.ai key lives under config.music, not config.providers.*
    music: mk(!!raw?.music?.apiKey, ENV_VAR.music),
  };
}

function isKeyTarget(v: unknown): v is KeyTarget {
  return v === "claude" || v === "openai" || v === "grok" || v === "music";
}

// PUT /api/config/providers  { vendor, apiKey }  — set (non-empty) or clear ("").
export async function handleProvidersApi(
  req: Request,
  url: URL,
  config: MantleConfig,
  basePath: string,
): Promise<Response> {
  if (url.pathname !== "/api/config/providers") return json({ error: "Not found" }, 404);
  if (req.method !== "PUT") return json({ error: "Method not allowed" }, 405);

  let body: { vendor?: unknown; apiKey?: unknown } | null;
  try {
    body = (await readJsonBody(req)) as { vendor?: unknown; apiKey?: unknown } | null;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const vendor = body?.vendor;
  if (!isKeyTarget(vendor)) {
    return json({ error: "vendor must be one of: claude, openai, grok, music" }, 400);
  }
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";

  // Validate a non-empty key before reporting success — but still save it
  // either way, so a transient probe failure can't block a valid key the user
  // just pasted. The UI surfaces `validation` so a rejected key is obvious.
  // The kie.ai (music) key has no cheap probe, so it's saved unverified and only
  // errors at generate-time — fine, since the player works without it.
  const validation = apiKey && vendor !== "music" ? await validateProviderKey(vendor, apiKey) : null;

  // Persist to the on-disk file (leak-safe — never touches env-baked values).
  saveConfig(basePath, (raw) => {
    if (vendor === "music") {
      if (!raw.music || typeof raw.music !== "object") raw.music = {};
      raw.music.apiKey = apiKey; // "" clears it
      return;
    }
    if (!raw.providers || typeof raw.providers !== "object") raw.providers = {};
    if (!raw.providers[vendor] || typeof raw.providers[vendor] !== "object") raw.providers[vendor] = {};
    raw.providers[vendor].apiKey = apiKey; // "" clears it
  });

  // Update the live config so the running server uses the new key immediately.
  // On clear, fall back to the env key (precedence: config > env).
  if (vendor === "music") {
    config.music.apiKey = apiKey || process.env[ENV_VAR.music] || "";
  } else {
    config.providers[vendor].apiKey = apiKey || process.env[ENV_VAR[vendor]] || "";
  }

  const set = vendor === "music" ? !!config.music.apiKey : !!config.providers[vendor].apiKey;
  const source: KeyState["source"] = apiKey ? "config" : process.env[ENV_VAR[vendor]] ? "env" : "none";
  return json({ ok: true, vendor, set, source, validation });
}

// PUT /api/config/user  { name }  — the user's profile name (how agents should
// address them). Resolves the live {{user}} placeholder in every agent's
// workspace files on the next prompt build (setUserName), and is the value
// baked into a new agent's CC-mode files at scaffold time. Persisted to disk,
// applied to the live config, and pushed to the prompt builder so a rename is
// immediate — no restart.
export async function handleUserProfileApi(
  req: Request,
  config: MantleConfig,
  basePath: string,
): Promise<Response> {
  if (req.method !== "PUT") return json({ error: "Method not allowed" }, 405);

  let body: { name?: unknown } | null;
  try {
    body = (await readJsonBody(req)) as { name?: unknown } | null;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const name = typeof body?.name === "string" ? body.name.trim() : "";

  saveConfig(basePath, (raw) => {
    if (!raw.user || typeof raw.user !== "object") raw.user = {};
    raw.user.name = name;
  });
  config.user = { name };
  // Push to the prompt builder so the live {{user}} variable updates without a
  // restart — the very next turn addresses the user by the new name.
  setUserName(name);

  return json({ ok: true, name });
}
