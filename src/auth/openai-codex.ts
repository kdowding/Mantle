/**
 * OpenAI Codex / ChatGPT-subscription OAuth.
 *
 * Talks to auth.openai.com to PKCE-login as a Codex CLI client, then exposes
 * a refreshable access token + decoded identity (chatgpt_account_id, plan,
 * email) for use by the openai-codex provider.
 *
 * Storage: .mantle/auth/openai-codex.json (mode 0600, gitignored via .mantle/).
 *
 * Refresh: any caller goes through `ensureValidCodexAccess(basePath)`. If the
 * access token has <60s left, the module refreshes via auth.openai.com and
 * persists the new tokens. Concurrent callers share one in-flight refresh
 * promise so the refresh token isn't reused (OpenAI rotates them — a second
 * use would fail with refresh_token_reused).
 *
 * An early proof-of-concept proved every piece of this flow end-to-end
 * against a Plus account on 2026-05-05.
 */

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import {
  writeFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { ensureSecureDir } from "./secure-dir.js";

// ---- Constants -----------------------------------------------------------

// OpenAI Codex CLI's published OAuth client id. Stable across CLI versions;
// openclaw uses the same one (extensions/openai/openai-codex-device-code.ts:5).
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SCOPE = "openid profile email offline_access";
const REDIRECT_PORT = 1455;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;
const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const ORIGINATOR = "mantle";
const USER_AGENT_VERSION = "0.1.0";
const REFRESH_LEEWAY_MS = 60_000; // refresh if access token expires within 60s
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;

// ---- Public types --------------------------------------------------------

export interface CodexTokens {
  access: string;
  refresh: string;
  idToken?: string;
  /** ms epoch when the access token expires (decoded from JWT.exp) */
  expires: number;
  /** ms epoch when these tokens were last obtained or refreshed */
  obtainedAt: number;
}

export interface CodexIdentity {
  accountId: string;
  email?: string;
  /** "plus" | "pro" | "team" | "enterprise" | "free" | ... */
  planType?: string;
  userId?: string;
}

export interface CodexAccess {
  access: string;
  identity: CodexIdentity;
  tokens: CodexTokens;
}

export class CodexAuthError extends Error {
  constructor(
    message: string,
    public code:
      | "no_credentials"
      | "refresh_failed"
      | "refresh_token_reused"
      | "missing_account_id"
      | "login_timeout"
      | "login_cancelled"
      | "network"
      | "invalid_jwt",
  ) {
    super(message);
    this.name = "CodexAuthError";
  }
}

// ---- Storage -------------------------------------------------------------

export function getCodexTokenPath(basePath: string): string {
  return resolve(basePath, ".mantle", "auth", "openai-codex.json");
}

export function loadCodexTokens(basePath: string): CodexTokens | null {
  const path = getCodexTokenPath(basePath);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof parsed?.access !== "string" ||
      typeof parsed?.refresh !== "string" ||
      typeof parsed?.expires !== "number"
    ) {
      return null;
    }
    return {
      access: parsed.access,
      refresh: parsed.refresh,
      idToken: typeof parsed.idToken === "string" ? parsed.idToken : undefined,
      expires: parsed.expires,
      obtainedAt:
        typeof parsed.obtainedAt === "number" ? parsed.obtainedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function saveCodexTokens(basePath: string, tokens: CodexTokens): void {
  const path = getCodexTokenPath(basePath);
  ensureSecureDir(dirname(path));
  // Atomic: a crash mid-write must not leave a torn token file.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function deleteCodexTokens(basePath: string): boolean {
  const path = getCodexTokenPath(basePath);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

// ---- JWT identity decoding ----------------------------------------------

interface CodexJwtPayload {
  exp?: number;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
    chatgpt_user_id?: string;
  };
  "https://api.openai.com/profile"?: {
    email?: string;
  };
}

function decodeJwtPayload(token: string): CodexJwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new CodexAuthError("Access token is not a JWT", "invalid_jwt");
  }
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new CodexAuthError("Could not decode JWT payload", "invalid_jwt");
  }
}

export function decodeCodexIdentity(accessToken: string): CodexIdentity {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload["https://api.openai.com/auth"] ?? {};
  const profile = payload["https://api.openai.com/profile"] ?? {};
  if (!auth.chatgpt_account_id) {
    throw new CodexAuthError(
      "JWT has no chatgpt_account_id — this account may lack a ChatGPT subscription",
      "missing_account_id",
    );
  }
  return {
    accountId: auth.chatgpt_account_id,
    planType: auth.chatgpt_plan_type,
    userId: auth.chatgpt_user_id,
    email: profile.email,
  };
}

function readJwtExpiryMs(accessToken: string): number {
  const payload = decodeJwtPayload(accessToken);
  if (typeof payload.exp !== "number") {
    // No exp claim — assume 1h from now as a conservative default.
    return Date.now() + 60 * 60_000;
  }
  return payload.exp * 1000;
}

// ---- Helpers -------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Escape provider-supplied strings before reflecting them into the loopback
// callback page. Local-only one-shot server, so the risk is small, but the
// `error`/`error_description` params ride the redirect and shouldn't be raw.
function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function buildAuthUrl(challenge: string, state: string): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

function tokenExchangeHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    originator: ORIGINATOR,
    "User-Agent": `${ORIGINATOR}/${USER_AGENT_VERSION}`,
  };
}

function isRefreshTokenReusedError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("refresh_token_reused") ||
    lower.includes("refresh token has already been used") ||
    lower.includes("already been used to generate a new access token")
  );
}

const SUCCESS_PAGE_HTML = `<!doctype html><html><head><title>Codex login complete</title>
<style>body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;margin:0;}h1{font-weight:600;margin-bottom:8px;}p{opacity:0.7;margin-top:0;}</style>
</head><body><h1>Codex login complete</h1><p>You can close this tab.</p></body></html>`;

// ---- Login (PKCE) --------------------------------------------------------

export interface LoginOptions {
  basePath: string;
  /** Called as soon as the auth URL is ready. Default: noop (caller handles printing). */
  onAuthUrl?: (url: string) => void;
  /** Override timeout for awaiting the browser callback. Default 5 min. */
  timeoutMs?: number;
}

export async function loginCodex(opts: LoginOptions): Promise<CodexTokens> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));
  const authUrl = buildAuthUrl(challenge, state);

  const tokens = await new Promise<CodexTokens>((resolveTokens, rejectTokens) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const server = createServer(async (req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end();
        return;
      }
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const finish = (status: number, html: string, err?: Error) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        server.close();
        if (err) rejectTokens(err);
      };
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const errParam = url.searchParams.get("error");
      const errDesc = url.searchParams.get("error_description");
      if (errParam) {
        return finish(
          400,
          `<h1>OAuth error</h1><pre>${htmlEscape(errParam)}\n${htmlEscape(errDesc ?? "")}</pre>`,
          new CodexAuthError(
            `OAuth error: ${errParam}${errDesc ? ` (${errDesc})` : ""}`,
            "login_cancelled",
          ),
        );
      }
      if (!code || returnedState !== state) {
        return finish(
          400,
          "<h1>Invalid callback (missing code or state mismatch).</h1>",
          new CodexAuthError("Callback missing code or state mismatch", "login_cancelled"),
        );
      }
      try {
        const tokenResp = await fetch(TOKEN_URL, {
          method: "POST",
          headers: tokenExchangeHeaders(),
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT_URI,
            client_id: CLIENT_ID,
            code_verifier: verifier,
          }),
        });
        const text = await tokenResp.text();
        if (!tokenResp.ok) {
          return finish(
            500,
            `<h1>Token exchange failed</h1><pre>${tokenResp.status}\n${text}</pre>`,
            new CodexAuthError(
              `Token exchange ${tokenResp.status}: ${text}`,
              "refresh_failed",
            ),
          );
        }
        const parsed = JSON.parse(text);
        const access = parsed.access_token;
        const refresh = parsed.refresh_token;
        if (typeof access !== "string" || typeof refresh !== "string") {
          return finish(
            500,
            "<h1>Token response missing tokens.</h1>",
            new CodexAuthError("Token response missing access/refresh tokens", "refresh_failed"),
          );
        }
        const result: CodexTokens = {
          access,
          refresh,
          idToken: typeof parsed.id_token === "string" ? parsed.id_token : undefined,
          expires: readJwtExpiryMs(access),
          obtainedAt: Date.now(),
        };
        finish(200, SUCCESS_PAGE_HTML);
        resolveTokens(result);
      } catch (e) {
        finish(
          500,
          `<h1>Token exchange threw</h1><pre>${String(e)}</pre>`,
          e instanceof Error ? e : new Error(String(e)),
        );
      }
    });

    server.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      rejectTokens(err);
    });
    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      opts.onAuthUrl?.(authUrl);
    });
    timeoutHandle = setTimeout(
      () => {
        server.close();
        rejectTokens(new CodexAuthError("Login timed out waiting for browser callback", "login_timeout"));
      },
      opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
    );
  });

  saveCodexTokens(opts.basePath, tokens);
  return tokens;
}

// ---- Server-friendly login ------------------------------------------------

// Tracks one in-flight server-initiated login at a time. Lets the API
// endpoint return the auth URL synchronously while the localhost:1455
// callback server keeps running in the background, waiting for the user to
// authorize. A second concurrent click on "Log in" reuses the existing URL
// instead of spawning a duplicate server (which would EADDRINUSE on 1455).
let loginInFlight: { authUrl: string | null; promise: Promise<CodexTokens> } | null = null;

export interface StartLoginResult {
  authUrl: string;
  /** True if a login was already running; we reused its URL. */
  preexisting: boolean;
}

/**
 * Kick off (or rejoin) a PKCE login. Returns the auth URL as soon as it's
 * generated; the callback server runs in the background until the user
 * authorizes (or the 5-min timeout). Tokens are persisted on success.
 *
 * The caller (typically a REST handler) returns the URL to the UI, which
 * opens it in a new window and then polls /api/auth/openai-codex/status
 * to detect completion.
 */
export async function startCodexLogin(opts: {
  basePath: string;
  timeoutMs?: number;
}): Promise<StartLoginResult> {
  if (loginInFlight?.authUrl) {
    return { authUrl: loginInFlight.authUrl, preexisting: true };
  }

  let captureUrl!: (url: string) => void;
  const urlReady = new Promise<string>((res) => {
    captureUrl = res;
  });

  const promise = loginCodex({
    basePath: opts.basePath,
    timeoutMs: opts.timeoutMs,
    onAuthUrl: (url) => {
      if (loginInFlight) loginInFlight.authUrl = url;
      captureUrl(url);
    },
  });

  loginInFlight = { authUrl: null, promise };
  // Clear the in-flight slot when the login settles either way so the next
  // click starts a fresh flow.
  promise.finally(() => {
    if (loginInFlight?.promise === promise) loginInFlight = null;
  });

  const authUrl = await urlReady;
  return { authUrl, preexisting: false };
}

/** True iff a server-initiated login is currently waiting for the browser. */
export function isCodexLoginInFlight(): boolean {
  return loginInFlight !== null;
}

// ---- Refresh -------------------------------------------------------------

export async function refreshCodexTokens(refreshToken: string): Promise<CodexTokens> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: tokenExchangeHeaders(),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: SCOPE,
    }),
  });
  const text = await resp.text();
  if (!resp.ok) {
    if (isRefreshTokenReusedError(text)) {
      throw new CodexAuthError(
        "Refresh token was reused. Run `mantle auth login` to re-authenticate.",
        "refresh_token_reused",
      );
    }
    throw new CodexAuthError(
      `Token refresh ${resp.status}: ${text}`,
      "refresh_failed",
    );
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CodexAuthError("Refresh response was not JSON", "refresh_failed");
  }
  const access = parsed.access_token;
  // OpenAI rotates refresh tokens on each refresh — use the new one if the
  // server returned one, else keep the original (some flows omit it).
  const refresh = typeof parsed.refresh_token === "string" ? parsed.refresh_token : refreshToken;
  if (typeof access !== "string") {
    throw new CodexAuthError("Refresh response missing access_token", "refresh_failed");
  }
  return {
    access,
    refresh,
    idToken: typeof parsed.id_token === "string" ? parsed.id_token : undefined,
    expires: readJwtExpiryMs(access),
    obtainedAt: Date.now(),
  };
}

// ---- Hot path: ensureValidCodexAccess ------------------------------------

// In-process refresh deduplication. Prevents two concurrent agent turns from
// both sending the same refresh token (OpenAI rotates them — second use
// would fail with refresh_token_reused). One in-flight refresh per process.
let refreshInFlight: Promise<CodexTokens> | null = null;

async function refreshAndPersist(basePath: string): Promise<CodexTokens> {
  if (refreshInFlight) return refreshInFlight;
  const p = (async () => {
    // Re-read INSIDE the lock: a refresh that completed between the
    // caller's token load and this closure already rotated the single-use
    // refresh token — spending the caller's stale copy would fail with
    // refresh_token_reused and force a re-login. If the on-disk tokens are
    // fresh again, return them without refreshing at all.
    const current = loadCodexTokens(basePath);
    if (!current) {
      throw new CodexAuthError(
        "No OpenAI Codex credentials. Run `mantle auth login` to authenticate.",
        "no_credentials",
      );
    }
    if (current.expires - Date.now() >= REFRESH_LEEWAY_MS) return current;
    const fresh = await refreshCodexTokens(current.refresh);
    saveCodexTokens(basePath, fresh);
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
 * Returns a valid access token + decoded identity, refreshing the saved
 * tokens first if they're within REFRESH_LEEWAY_MS of expiring.
 *
 * Throws CodexAuthError("no_credentials") if no tokens are saved — caller
 * should surface that as "run mantle auth login".
 */
export async function ensureValidCodexAccess(basePath: string): Promise<CodexAccess> {
  let tokens = loadCodexTokens(basePath);
  if (!tokens) {
    throw new CodexAuthError(
      "No OpenAI Codex credentials. Run `mantle auth login` to authenticate.",
      "no_credentials",
    );
  }
  if (tokens.expires - Date.now() < REFRESH_LEEWAY_MS) {
    tokens = await refreshAndPersist(basePath);
  }
  const identity = decodeCodexIdentity(tokens.access);
  return { access: tokens.access, identity, tokens };
}

// ---- Misc utilities ------------------------------------------------------

/** Best-effort cross-platform "open URL in default browser". Never throws. */
export function tryOpenBrowser(url: string): void {
  let cmd: string;
  let args: string[];
  switch (process.platform) {
    case "win32":
      cmd = "cmd";
      args = ["/c", "start", "", url];
      break;
    case "darwin":
      cmd = "open";
      args = [url];
      break;
    default:
      cmd = "xdg-open";
      args = [url];
  }
  try {
    Bun.spawn([cmd, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    /* caller should have printed the URL anyway */
  }
}
