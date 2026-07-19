/**
 * Grok Build subscription auth.
 *
 * grok build (xAI's coding CLI) authenticates via auth.x.ai OIDC and caches
 * tokens at ~/.grok/auth.json. MANTLE reuses that login rather than running
 * its own — it reads ~/.grok/auth.json for the access token, and when the
 * token is near expiry, refreshes it against auth.x.ai/oauth2/token and
 * persists the result to MANTLE's own store, .mantle/auth/grok-build.json
 * (mode 0600, gitignored via .mantle/).
 *
 * Why reuse grok build's login instead of a separate `mantle auth login`?
 * grok build's OAuth client registration (redirect URIs, allowed grants)
 * isn't documented, and the user is already signed in to grok build — reusing
 * that login is zero-friction. The wire details we DO have (token endpoint,
 * refresh_token grant, public client) come from auth.x.ai's OIDC discovery
 * doc and the ~/.grok/auth.json structure.
 *
 * Token-store split: MANTLE refreshes into its OWN store and never writes
 * ~/.grok/auth.json. ensureValidGrokAccess() reads BOTH stores each call and
 * uses whichever access token is fresher, so a refresh on either side (MANTLE
 * or the grok CLI) is picked up by the other. Known edge: refresh tokens
 * rotate single-use, so once the two stores diverge, one side's refresh token
 * dies and that side needs a re-login (run `grok`). Access tokens are
 * independent per refresh, so MANTLE keeps working as long as either store
 * holds a live refresh token.
 */

import { writeFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { ensureSecureDir } from "./secure-dir.js";

// ---- Constants -----------------------------------------------------------

// grok build's per-user OIDC credential cache.
const GROK_CLI_AUTH_PATH = join(homedir(), ".grok", "auth.json");
// ~/.grok/auth.json keys each credential set under a scope URL; the OIDC one
// is "https://auth.x.ai::<client-uuid>". We match on this prefix.
const OIDC_SCOPE_PREFIX = "https://auth.x.ai::";
const DEFAULT_ISSUER = "https://auth.x.ai";
const TOKEN_ENDPOINT_PATH = "/oauth2/token";
// Refresh if the access token expires within this window.
const REFRESH_LEEWAY_MS = 60_000;

// ---- Public types --------------------------------------------------------

export interface GrokTokens {
  access: string;
  refresh: string;
  /** ms epoch when the access token expires */
  expires: number;
  /** ms epoch when these tokens were last obtained/refreshed by MANTLE */
  obtainedAt: number;
  /** OIDC issuer base, e.g. https://auth.x.ai */
  issuer: string;
  /** OIDC client id — needed for the refresh grant (public client) */
  clientId: string;
  userId?: string;
  email?: string;
}

export interface GrokIdentity {
  userId: string;
  email?: string;
}

export interface GrokAccess {
  access: string;
  identity: GrokIdentity;
  tokens: GrokTokens;
}

export class GrokAuthError extends Error {
  constructor(
    message: string,
    public code:
      | "no_credentials"
      | "refresh_failed"
      | "refresh_token_reused"
      | "invalid_auth_file"
      | "network",
  ) {
    super(message);
    this.name = "GrokAuthError";
  }
}

// ---- JWT helpers ---------------------------------------------------------

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function readJwtExpiryMs(token: string): number {
  const exp = decodeJwtPayload(token)?.exp;
  if (typeof exp === "number") return exp * 1000;
  // No exp claim — assume 30 min out, conservative.
  return Date.now() + 30 * 60_000;
}

function parseIsoToMs(iso: string | undefined): number {
  if (!iso) return 0;
  // grok build writes nanosecond-precision ISO (Rust chrono); JS Date.parse
  // handles milliseconds — truncate any excess fractional digits.
  const normalized = iso.replace(/(\.\d{3})\d+/, "$1");
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

// JWT exp is authoritative for when the token actually expires; the ISO
// expires_at field is a fallback, and a conservative 30-min window the last.
function resolveExpiry(accessJwt: string, isoFallback: string | undefined): number {
  const exp = decodeJwtPayload(accessJwt)?.exp;
  if (typeof exp === "number") return exp * 1000;
  const iso = parseIsoToMs(isoFallback);
  return iso > 0 ? iso : Date.now() + 30 * 60_000;
}

// ---- grok CLI's store (~/.grok/auth.json) — READ ONLY --------------------

// Shape of one credential entry inside ~/.grok/auth.json. grok build writes
// more fields (first_name, team_id, principal_*, ...); we only read these.
interface GrokCliAuthEntry {
  key?: string; // the access token (JWT)
  refresh_token?: string;
  expires_at?: string; // ISO 8601 timestamp
  oidc_issuer?: string;
  oidc_client_id?: string;
  user_id?: string;
  email?: string;
}

/**
 * Read grok build's own credential cache. Returns null if the file is absent,
 * unparseable, or has no usable OIDC entry. Never throws — a missing/garbled
 * grok login is just "no credentials from this source".
 */
export function loadGrokCliTokens(): GrokTokens | null {
  if (!existsSync(GROK_CLI_AUTH_PATH)) return null;
  let parsed: Record<string, GrokCliAuthEntry>;
  try {
    parsed = JSON.parse(readFileSync(GROK_CLI_AUTH_PATH, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  // Prefer the https://auth.x.ai::<uuid> OIDC entry; fall back to any entry
  // that carries both an access token and a refresh token.
  let entry: GrokCliAuthEntry | undefined;
  for (const [scope, val] of Object.entries(parsed)) {
    if (scope.startsWith(OIDC_SCOPE_PREFIX) && val?.key && val?.refresh_token) {
      entry = val;
      break;
    }
  }
  if (!entry) {
    for (const val of Object.values(parsed)) {
      if (val?.key && val?.refresh_token) {
        entry = val;
        break;
      }
    }
  }
  if (!entry?.key || !entry.refresh_token || !entry.oidc_client_id) return null;

  return {
    access: entry.key,
    refresh: entry.refresh_token,
    expires: resolveExpiry(entry.key, entry.expires_at),
    obtainedAt: Date.now(),
    issuer: entry.oidc_issuer || DEFAULT_ISSUER,
    clientId: entry.oidc_client_id,
    userId: entry.user_id,
    email: entry.email,
  };
}

// ---- MANTLE's own store (.mantle/auth/grok-build.json) -------------------

export function getGrokTokenPath(basePath: string): string {
  return resolve(basePath, ".mantle", "auth", "grok-build.json");
}

export function loadMantleGrokTokens(basePath: string): GrokTokens | null {
  const path = getGrokTokenPath(basePath);
  if (!existsSync(path)) return null;
  try {
    const p = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof p?.access !== "string" ||
      typeof p?.refresh !== "string" ||
      typeof p?.expires !== "number"
    ) {
      return null;
    }
    return {
      access: p.access,
      refresh: p.refresh,
      expires: p.expires,
      obtainedAt: typeof p.obtainedAt === "number" ? p.obtainedAt : Date.now(),
      issuer: typeof p.issuer === "string" ? p.issuer : DEFAULT_ISSUER,
      clientId: typeof p.clientId === "string" ? p.clientId : "",
      userId: typeof p.userId === "string" ? p.userId : undefined,
      email: typeof p.email === "string" ? p.email : undefined,
    };
  } catch {
    return null;
  }
}

export function saveMantleGrokTokens(basePath: string, tokens: GrokTokens): void {
  const path = getGrokTokenPath(basePath);
  ensureSecureDir(dirname(path));
  // Atomic: a crash mid-write must not leave a torn token file.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

// ---- Refresh -------------------------------------------------------------

/**
 * Exchange a refresh token for a fresh access token against auth.x.ai's OIDC
 * token endpoint. Public client — no client secret. Refresh tokens rotate, so
 * the response's refresh_token (when present) replaces the old one.
 */
export async function refreshGrokTokens(tokens: GrokTokens): Promise<GrokTokens> {
  if (!tokens.clientId) {
    throw new GrokAuthError(
      "Cannot refresh Grok token: no OIDC client id. Run `grok` to refresh ~/.grok/auth.json.",
      "refresh_failed",
    );
  }
  const tokenUrl = tokens.issuer.replace(/\/+$/, "") + TOKEN_ENDPOINT_PATH;
  // Pin the issuer host: `issuer` is read from ~/.grok/auth.json, which other
  // local tooling can write — without this check a tampered issuer would
  // receive our refresh token (a long-lived credential) verbatim.
  let issuerHost = "";
  try {
    const u = new URL(tokenUrl);
    if (u.protocol === "https:") issuerHost = u.hostname;
  } catch { /* unparseable → rejected below */ }
  if (issuerHost !== "auth.x.ai" && !issuerHost.endsWith(".x.ai")) {
    throw new GrokAuthError(
      `Grok token issuer "${tokens.issuer}" is not an x.ai host — refusing to send the refresh token. Re-run \`grok\` to repair ~/.grok/auth.json.`,
      "refresh_failed",
    );
  }

  let resp: Response;
  try {
    resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh,
        client_id: tokens.clientId,
      }),
    });
  } catch (e) {
    throw new GrokAuthError(
      `Grok token refresh network error: ${e instanceof Error ? e.message : String(e)}`,
      "network",
    );
  }

  const text = await resp.text();
  if (!resp.ok) {
    if (/refresh_token_reused|already been used|invalid_grant/i.test(text)) {
      throw new GrokAuthError(
        "Grok refresh token was rejected (rotated or expired). Run `grok` and sign in to refresh ~/.grok/auth.json.",
        "refresh_token_reused",
      );
    }
    throw new GrokAuthError(`Grok token refresh ${resp.status}: ${text}`, "refresh_failed");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GrokAuthError("Grok refresh response was not JSON", "refresh_failed");
  }
  const access = parsed.access_token;
  if (typeof access !== "string") {
    throw new GrokAuthError("Grok refresh response missing access_token", "refresh_failed");
  }
  // auth.x.ai rotates refresh tokens — adopt the new one if returned.
  const refresh =
    typeof parsed.refresh_token === "string" ? parsed.refresh_token : tokens.refresh;
  const expires =
    typeof parsed.expires_in === "number"
      ? Date.now() + parsed.expires_in * 1000
      : readJwtExpiryMs(access);

  return {
    access,
    refresh,
    expires,
    obtainedAt: Date.now(),
    issuer: tokens.issuer,
    clientId: tokens.clientId,
    userId: tokens.userId,
    email: tokens.email,
  };
}

// ---- Hot path: ensureValidGrokAccess -------------------------------------

// In-process refresh dedup — concurrent agent turns share one in-flight
// refresh so a rotating refresh token isn't spent twice (mirrors the codex
// module's refreshInFlight).
let refreshInFlight: Promise<GrokTokens> | null = null;

async function refreshAndPersist(basePath: string): Promise<GrokTokens> {
  if (refreshInFlight) return refreshInFlight;
  const p = (async () => {
    // Re-read INSIDE the lock (both stores): a refresh that completed
    // between the caller's load and this closure already rotated the
    // single-use refresh token — spending the caller's stale copy would be
    // rejected and cost this side its login. If the freshest on-disk token
    // is no longer near expiry, return it without refreshing.
    const cli = loadGrokCliTokens();
    const mantle = loadMantleGrokTokens(basePath);
    const current: GrokTokens | null =
      cli && mantle ? (cli.expires >= mantle.expires ? cli : mantle) : (cli ?? mantle);
    if (!current) {
      throw new GrokAuthError(
        "No Grok Build credentials found. Sign in to grok build first (run `grok`), then retry.",
        "no_credentials",
      );
    }
    if (current.expires - Date.now() >= REFRESH_LEEWAY_MS) return current;
    const fresh = await refreshGrokTokens(current);
    saveMantleGrokTokens(basePath, fresh);
    return fresh;
  })();
  refreshInFlight = p;
  // Clear the slot AFTER the assignment, via microtask. An inline
  // `finally { refreshInFlight = null }` inside the async body runs BEFORE
  // the outer assignment when the body completes synchronously (the
  // on-disk-tokens-fresh early return) — the assignment then re-pins the
  // settled promise and refresh never runs again until restart.
  const clear = () => {
    if (refreshInFlight === p) refreshInFlight = null;
  };
  p.then(clear, clear);
  return p;
}

/**
 * Returns a valid access token + identity for the grok-build provider.
 *
 * Reads both credential stores (grok CLI's ~/.grok/auth.json and MANTLE's own
 * .mantle/auth/grok-build.json), picks whichever has the fresher access
 * token, and refreshes it if it's within REFRESH_LEEWAY_MS of expiring.
 * Refreshed tokens are persisted to MANTLE's own store only.
 *
 * Throws GrokAuthError("no_credentials") if neither store has credentials —
 * the caller should surface "sign in to grok build first".
 */
export async function ensureValidGrokAccess(basePath: string): Promise<GrokAccess> {
  const cli = loadGrokCliTokens();
  const mantle = loadMantleGrokTokens(basePath);

  if (!cli && !mantle) {
    throw new GrokAuthError(
      "No Grok Build credentials found. Sign in to grok build first (run `grok`), then retry.",
      "no_credentials",
    );
  }

  // Pick the store with the later-expiring (fresher) access token.
  let tokens: GrokTokens =
    cli && mantle ? (cli.expires >= mantle.expires ? cli : mantle) : (cli ?? mantle)!;

  if (tokens.expires - Date.now() < REFRESH_LEEWAY_MS) {
    tokens = await refreshAndPersist(basePath);
  }

  // Identity: prefer the explicit user_id/email carried in either store;
  // fall back to JWT claims if neither had them.
  let userId = tokens.userId ?? "";
  let email = tokens.email;
  if (!userId) {
    const payload = decodeJwtPayload(tokens.access);
    if (typeof payload?.sub === "string") userId = payload.sub;
    if (!email && typeof payload?.email === "string") email = payload.email;
  }

  return { access: tokens.access, identity: { userId, email }, tokens };
}
