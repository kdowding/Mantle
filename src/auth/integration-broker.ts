// IntegrationBroker — the per-(agent, integration) credential store + token
// lifecycle behind the TokenBroker port (src/integrations/types.ts). This is
// the generalization of auth/openai-codex.ts: a PAT store (paste a long-lived
// token) AND a provider-agnostic OAuth2 engine (PKCE + loopback callback +
// token exchange + refresh) driven entirely by the IntegrationAuth spec — no
// per-vendor branches, so adding an OAuth integration is declaring a spec, not
// writing a flow.
//
// Storage: .mantle/auth/integrations/<agentId>/<integrationId>.json, mode 0600,
// gitignored via .mantle/. Read FRESH from disk on every call (no cache) so a
// `mantle integrations connect` from the CLI is seen immediately by an already-
// running server — the same live-read discipline as the local model registry.

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync, existsSync, readFileSync, rmSync, readdirSync, renameSync } from "fs";
import { resolve, dirname, join } from "path";
import { ensureSecureDir } from "./secure-dir.js";
import type { TokenBroker, IntegrationConnectionInfo, IntegrationAuth } from "../integrations/types.js";

const REFRESH_LEEWAY_MS = 60_000; // refresh if the access token expires within 60s
const OAUTH_REDIRECT_PORT = 1456; // distinct from Codex's 1455; loopback only
const OAUTH_REDIRECT_URI = `http://127.0.0.1:${OAUTH_REDIRECT_PORT}/callback`;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;

type OAuthSpec = Extract<IntegrationAuth, { kind: "oauth2" }>;
interface OAuthCreds {
  clientId: string;
  clientSecret?: string;
}
interface RegisteredAuth {
  auth: IntegrationAuth;
  creds?: OAuthCreds;
}

interface StoredCredential {
  kind: "pat" | "oauth2";
  token: string;
  refresh?: string;
  account?: string;
  scopes: string[];
  writeEnabled: boolean;
  connectedAt: number;
  expiresAt?: number;
}

// ids are internal, but never let one escape the auth dir (path traversal).
function sanitize(seg: string): string {
  return seg.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// Escape a provider-supplied string before reflecting it into the loopback
// callback HTML. The page is served only to the local user's own browser from a
// one-shot localhost server, so the blast radius is tiny — but the `error`
// param is attacker-influenceable (it rides the redirect), so don't reflect it raw.
function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

// Refuse to send the client secret / refresh token anywhere but an HTTPS
// endpoint. OAuth specs are in-code constants today (Gmail → Google, all https),
// but this fails closed if a future config-driven or contributed spec ever
// carried a non-TLS token URL — credentials must never leave over plaintext.
// Native single-provider modules (auth/grok-build.ts) pin the exact issuer host;
// the generic broker can't (providers split authorize and token across hosts),
// so HTTPS is the floor it enforces here.
function assertSecureCredentialEndpoint(rawUrl: string): void {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid OAuth token URL: ${rawUrl}`);
  }
  if (u.protocol !== "https:") {
    throw new Error(`Refusing to send OAuth credentials to a non-HTTPS endpoint: ${rawUrl}`);
  }
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Standard OIDC id_token → email claim. Generic (not Google-specific): any
// provider that returns an id_token with `openid email` scope exposes it here.
function decodeJwtEmail(idToken: string): string | undefined {
  const parts = idToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return typeof payload?.email === "string" ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

const OAUTH_SUCCESS_HTML = `<!doctype html><html><head><title>Connected</title>
<style>body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;margin:0;}h1{font-weight:600;margin-bottom:8px;}p{opacity:0.7;margin-top:0;}</style>
</head><body><h1>Integration connected</h1><p>You can close this tab.</p></body></html>`;

export class IntegrationBroker implements TokenBroker {
  // OAuth specs + the user's app creds, registered at boot so getAccessToken
  // can refresh. PAT integrations never register here.
  private authSpecs = new Map<string, RegisteredAuth>();
  // One in-flight refresh per (integration, agent) — a rotating refresh token
  // must not be spent twice concurrently.
  private refreshInFlight = new Map<string, Promise<string>>();

  constructor(private basePath: string) {}

  registerAuth(integrationId: string, auth: IntegrationAuth, creds?: OAuthCreds): void {
    this.authSpecs.set(integrationId, { auth, creds });
  }

  private dir(agentId: string): string {
    return resolve(this.basePath, ".mantle", "auth", "integrations", sanitize(agentId));
  }

  private path(integrationId: string, agentId: string): string {
    return join(this.dir(agentId), `${sanitize(integrationId)}.json`);
  }

  private read(integrationId: string, agentId: string): StoredCredential | null {
    const p = this.path(integrationId, agentId);
    if (!existsSync(p)) return null;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      if (typeof parsed?.token !== "string") return null;
      return {
        kind: parsed.kind === "oauth2" ? "oauth2" : "pat",
        token: parsed.token,
        refresh: typeof parsed.refresh === "string" ? parsed.refresh : undefined,
        account: typeof parsed.account === "string" ? parsed.account : undefined,
        scopes: Array.isArray(parsed.scopes)
          ? parsed.scopes.filter((s: unknown): s is string => typeof s === "string")
          : [],
        writeEnabled: parsed.writeEnabled === true,
        connectedAt: typeof parsed.connectedAt === "number" ? parsed.connectedAt : 0,
        expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined,
      };
    } catch {
      return null;
    }
  }

  private writeRecord(integrationId: string, agentId: string, record: StoredCredential): void {
    const p = this.path(integrationId, agentId);
    ensureSecureDir(dirname(p));
    // Atomic: a crash mid-write must not leave a torn credential file.
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    renameSync(tmp, p);
  }

  // ── TokenBroker port (the read surface tools depend on) ─────────────────

  async getAccessToken(integrationId: string, agentId: string): Promise<string> {
    const cred = this.read(integrationId, agentId);
    if (!cred) {
      throw new Error(
        `Integration "${integrationId}" is not connected for agent "${agentId}". ` +
          `Run \`mantle integrations connect ${integrationId} --agent ${agentId}\`.`,
      );
    }
    if (cred.kind === "pat") return cred.token;
    // oauth2: refresh if the access token is within the leeway of expiring.
    if (cred.expiresAt && cred.expiresAt - Date.now() < REFRESH_LEEWAY_MS) {
      return this.refreshOAuth(integrationId, agentId);
    }
    return cred.token;
  }

  connectionInfo(integrationId: string, agentId: string): IntegrationConnectionInfo | null {
    const cred = this.read(integrationId, agentId);
    if (!cred) return null;
    return {
      account: cred.account,
      scopes: cred.scopes,
      writeEnabled: cred.writeEnabled,
      expiresAt: cred.expiresAt,
    };
  }

  // ── Connect (write side — CLI / future REST, never the tools) ───────────

  // PAT: store a pasted token plus whatever the integration's verifyToken
  // reported (account / scopes / writeEnabled).
  connect(
    integrationId: string,
    agentId: string,
    token: string,
    info?: { account?: string; scopes?: string[]; writeEnabled?: boolean },
  ): void {
    this.writeRecord(integrationId, agentId, {
      kind: "pat",
      token,
      account: info?.account,
      scopes: info?.scopes ?? [],
      writeEnabled: info?.writeEnabled === true,
      connectedAt: Date.now(),
    });
  }

  // OAuth2: run the authorization-code (PKCE) flow against the spec, exchange
  // for tokens, and store them. The caller opens the browser via onAuthUrl and
  // the loopback callback completes the dance. Provider-agnostic — Gmail and
  // any future OAuth integration drive this with only their spec + creds.
  async connectOAuth(params: {
    integrationId: string;
    agentId: string;
    spec: OAuthSpec;
    creds: OAuthCreds;
    includeWrite?: boolean;
    onAuthUrl: (url: string) => void;
    timeoutMs?: number;
  }): Promise<IntegrationConnectionInfo> {
    const { integrationId, agentId, spec, creds, includeWrite, onAuthUrl } = params;
    const usePkce = spec.usePkce !== false; // default ON
    const verifier = base64url(randomBytes(32));
    const challenge = usePkce ? base64url(createHash("sha256").update(verifier).digest()) : "";
    const state = base64url(randomBytes(16));
    const scopes = [...spec.readScopes, ...(includeWrite ? (spec.writeScopes ?? []) : [])];

    const authUrl = new URL(spec.authorizeUrl);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", creds.clientId);
    authUrl.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
    authUrl.searchParams.set("scope", scopes.join(" "));
    authUrl.searchParams.set("state", state);
    if (usePkce) {
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
    }
    for (const [k, v] of Object.entries(spec.extraAuthParams ?? {})) {
      authUrl.searchParams.set(k, v);
    }

    const code = await new Promise<string>((resolveCode, rejectCode) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const server = createServer((req, res) => {
        if (!req.url) {
          res.writeHead(400);
          res.end();
          return;
        }
        const u = new URL(req.url, OAUTH_REDIRECT_URI);
        if (u.pathname !== "/callback") {
          res.writeHead(404);
          res.end();
          return;
        }
        const finish = (status: number, html: string, err?: Error) => {
          res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
          if (timer) clearTimeout(timer);
          server.close();
          if (err) rejectCode(err);
        };
        const errParam = u.searchParams.get("error");
        if (errParam) {
          return finish(400, `<h1>OAuth error</h1><pre>${htmlEscape(errParam)}</pre>`, new Error(`OAuth error: ${errParam}`));
        }
        const gotCode = u.searchParams.get("code");
        const gotState = u.searchParams.get("state");
        if (!gotCode || gotState !== state) {
          return finish(400, "<h1>Invalid callback (missing code or state mismatch).</h1>", new Error("callback missing code or state mismatch"));
        }
        finish(200, OAUTH_SUCCESS_HTML);
        resolveCode(gotCode);
      });
      server.on("error", (err) => {
        if (timer) clearTimeout(timer);
        rejectCode(err);
      });
      server.listen(OAUTH_REDIRECT_PORT, "127.0.0.1", () => onAuthUrl(authUrl.toString()));
      timer = setTimeout(() => {
        server.close();
        rejectCode(new Error("OAuth login timed out waiting for browser callback"));
      }, params.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
    });

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: OAUTH_REDIRECT_URI,
      client_id: creds.clientId,
    });
    if (usePkce) body.set("code_verifier", verifier);
    if (creds.clientSecret) body.set("client_secret", creds.clientSecret);

    assertSecureCredentialEndpoint(spec.tokenUrl);
    const resp = await fetch(spec.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`token exchange ${resp.status}: ${text}`);
    const parsed = JSON.parse(text) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      id_token?: string;
    };
    if (typeof parsed.access_token !== "string") throw new Error("token response missing access_token");

    const grantedScopes =
      typeof parsed.scope === "string" && parsed.scope.trim().length > 0 ? parsed.scope.split(/\s+/) : scopes;
    const writeEnabled = (spec.writeScopes ?? []).some((s) => grantedScopes.includes(s));
    const account = parsed.id_token ? decodeJwtEmail(parsed.id_token) : undefined;
    const expiresAt = typeof parsed.expires_in === "number" ? Date.now() + parsed.expires_in * 1000 : undefined;

    this.writeRecord(integrationId, agentId, {
      kind: "oauth2",
      token: parsed.access_token,
      refresh: parsed.refresh_token,
      account,
      scopes: grantedScopes,
      writeEnabled,
      connectedAt: Date.now(),
      expiresAt,
    });
    // Make refresh work in this process too (the server registers at boot).
    this.registerAuth(integrationId, spec, creds);
    return { account, scopes: grantedScopes, writeEnabled, expiresAt };
  }

  private async refreshOAuth(integrationId: string, agentId: string): Promise<string> {
    const key = `${integrationId}:${agentId}`;
    const existing = this.refreshInFlight.get(key);
    if (existing) return existing;

    const p = (async () => {
      const cred = this.read(integrationId, agentId);
      if (!cred) throw new Error(`Integration "${integrationId}" not connected for "${agentId}".`);
      // Re-check freshness inside the lock — a concurrent refresh may have
      // already rotated the token.
      if (cred.expiresAt && cred.expiresAt - Date.now() >= REFRESH_LEEWAY_MS) return cred.token;
      if (!cred.refresh) {
        throw new Error(`No refresh token for "${integrationId}"/"${agentId}" — reconnect.`);
      }
      const reg = this.authSpecs.get(integrationId);
      const auth = reg?.auth;
      if (!auth || auth.kind !== "oauth2") {
        throw new Error(`OAuth spec for "${integrationId}" not registered — cannot refresh.`);
      }
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: cred.refresh,
        client_id: reg?.creds?.clientId ?? "",
      });
      if (reg?.creds?.clientSecret) body.set("client_secret", reg.creds.clientSecret);

      assertSecureCredentialEndpoint(auth.tokenUrl);
      const resp = await fetch(auth.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const text = await resp.text();
      if (!resp.ok) throw new Error(`token refresh ${resp.status}: ${text}`);
      const parsed = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (typeof parsed.access_token !== "string") throw new Error("refresh response missing access_token");

      const updated: StoredCredential = {
        ...cred,
        token: parsed.access_token,
        // Most providers (Google) keep the same refresh token; honor a rotated
        // one if returned.
        refresh: typeof parsed.refresh_token === "string" ? parsed.refresh_token : cred.refresh,
        expiresAt: typeof parsed.expires_in === "number" ? Date.now() + parsed.expires_in * 1000 : cred.expiresAt,
      };
      this.writeRecord(integrationId, agentId, updated);
      return updated.token;
    })();

    this.refreshInFlight.set(key, p);
    p.then(
      () => this.refreshInFlight.delete(key),
      () => this.refreshInFlight.delete(key),
    );
    return p;
  }

  // ── Disconnect / inspection / purge ─────────────────────────────────────

  disconnect(integrationId: string, agentId: string): boolean {
    const p = this.path(integrationId, agentId);
    if (!existsSync(p)) return false;
    rmSync(p);
    return true;
  }

  listForAgent(agentId: string): string[] {
    const d = this.dir(agentId);
    if (!existsSync(d)) return [];
    try {
      return readdirSync(d)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""));
    } catch {
      return [];
    }
  }

  purgeAgent(agentId: string): number {
    const d = this.dir(agentId);
    if (!existsSync(d)) return 0;
    let n = 0;
    try {
      for (const f of readdirSync(d)) {
        if (f.endsWith(".json")) {
          rmSync(join(d, f));
          n++;
        }
      }
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort — a leftover dir is harmless */
    }
    return n;
  }
}
