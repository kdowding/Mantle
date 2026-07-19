/**
 * The inbound-auth gate: turns the session-token + credential primitives into
 * (a) a `requireAuth` check the server applies to every gated surface and
 * (b) the four auth endpoints the SPA talks to.
 *
 * Endpoints (all under /api/auth/, distinct from the /api/auth/openai-codex/*
 * provider-auth routes handled in api.ts):
 *   GET  /api/auth/session  → { authenticated, username, setupRequired }
 *   POST /api/auth/setup    → first-run account creation (refused once set up)
 *   POST /api/auth/login    → verify credentials, set cookie
 *   POST /api/auth/logout   → clear cookie
 *
 * When auth is disabled (config.server.auth.enabled=false or
 * MANTLE_AUTH_DISABLED=1) the gate reports everyone as authenticated so the
 * SPA proceeds straight to the app — for pure-loopback dev.
 */

import { createUser, hasAnyUser, verifyUser } from "../auth/credentials.js";
import { parseCookie, type SessionAuth } from "../auth/session-token.js";

const AUTH_PATHS = new Set([
  "/api/auth/session",
  "/api/auth/setup",
  "/api/auth/login",
  "/api/auth/logout",
]);

// Per-IP login throttle. In-memory (resets on restart) — fine for a
// single-user harness; it only needs to blunt online password guessing.
// Bounded: an IP-spraying client would otherwise grow the map without
// limit (each spoofed/proxied source address is a fresh key).
const MAX_FAILURES = 8;
const LOCKOUT_MS = 5 * 60 * 1000;
const MAX_TRACKED_IPS = 2000;
const loginFailures = new Map<string, { count: number; until: number }>();

function isLockedOut(ip: string): boolean {
  const entry = loginFailures.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.until) {
    loginFailures.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(ip: string): void {
  if (loginFailures.size >= MAX_TRACKED_IPS && !loginFailures.has(ip)) {
    // Sweep expired entries first; if the map is still saturated, evict the
    // oldest-inserted (Map preserves insertion order). Worst case an
    // attacker cycles a lockout away early — the argon2 verify cost still
    // rate-limits the actual guessing.
    const now = Date.now();
    for (const [k, v] of loginFailures) {
      if (now > v.until) loginFailures.delete(k);
    }
    while (loginFailures.size >= MAX_TRACKED_IPS) {
      const oldest = loginFailures.keys().next().value;
      if (oldest === undefined) break;
      loginFailures.delete(oldest);
    }
  }
  const entry = loginFailures.get(ip) ?? { count: 0, until: 0 };
  entry.count += 1;
  entry.until = Date.now() + LOCKOUT_MS;
  loginFailures.set(ip, entry);
}

function clearFailures(ip: string): void {
  loginFailures.delete(ip);
}

function json(data: unknown, status = 200, setCookie?: string): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return new Response(JSON.stringify(data), { status, headers });
}

async function readCredentials(
  req: Request,
): Promise<{ username: string; password: string } | null> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const { username, password } = body as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string") return null;
  return { username, password };
}

export interface AuthGate {
  readonly enabled: boolean;
  /** Resolve the logged-in username from the request cookie, or null. */
  requireAuth(req: Request): Promise<string | null>;
  /** Handle an /api/auth/* endpoint, or return null if `req` isn't one. */
  handleAuthEndpoint(req: Request, url: URL, basePath: string, clientIp: string): Promise<Response | null>;
}

export function createAuthGate(session: SessionAuth, enabled: boolean): AuthGate {
  async function requireAuth(req: Request): Promise<string | null> {
    const token = parseCookie(req.headers.get("cookie"), session.cookieName);
    const result = await session.verify(token);
    return result?.username ?? null;
  }

  async function handleAuthEndpoint(
    req: Request,
    url: URL,
    basePath: string,
    clientIp: string,
  ): Promise<Response | null> {
    const path = url.pathname;
    if (!AUTH_PATHS.has(path)) return null;
    const method = req.method;

    // ── session status (always GET, always public) ──────────────────────
    if (path === "/api/auth/session" && method === "GET") {
      if (!enabled) {
        return json({ authenticated: true, username: null, setupRequired: false, authDisabled: true });
      }
      const username = await requireAuth(req);
      return json({
        authenticated: username !== null,
        username,
        setupRequired: !hasAnyUser(basePath),
      });
    }

    // ── logout (clear cookie; safe to call unauthenticated) ──────────────
    if (path === "/api/auth/logout" && method === "POST") {
      return json({ ok: true }, 200, session.buildClearCookie());
    }

    if (!enabled) {
      // Login/setup are meaningless when auth is off.
      return json({ ok: true, authDisabled: true });
    }

    // ── first-run account creation ───────────────────────────────────────
    if (path === "/api/auth/setup" && method === "POST") {
      if (hasAnyUser(basePath)) {
        return json({ ok: false, error: "An account already exists." }, 409);
      }
      // Account creation is the one unauthenticated write. On a non-loopback
      // bind (server.host = 0.0.0.0 / a LAN IP) the FIRST network client to
      // reach this endpoint would claim the account — a remote takeover before
      // the owner ever logs in. Restrict first-run setup to the local machine.
      // Intentional remote first-setup (e.g. over Tailscale on a headless box)
      // opts in with MANTLE_ALLOW_REMOTE_SETUP=1.
      if (!isLoopbackAddress(clientIp) && process.env.MANTLE_ALLOW_REMOTE_SETUP !== "1") {
        return json(
          {
            ok: false,
            error:
              "First-run account setup must be done from the local machine. Open the app on the host itself, or set MANTLE_ALLOW_REMOTE_SETUP=1 to allow remote setup.",
          },
          403,
        );
      }
      const creds = await readCredentials(req);
      if (!creds) return json({ ok: false, error: "username and password are required." }, 400);
      const result = await createUser(basePath, creds.username, creds.password);
      if (!result.ok) return json({ ok: false, error: result.error }, 400);
      const token = await session.sign(creds.username.trim());
      return json({ ok: true, username: creds.username.trim() }, 200, session.buildSetCookie(token));
    }

    // ── login ────────────────────────────────────────────────────────────
    if (path === "/api/auth/login" && method === "POST") {
      if (isLockedOut(clientIp)) {
        return json({ ok: false, error: "Too many failed attempts. Try again in a few minutes." }, 429);
      }
      const creds = await readCredentials(req);
      if (!creds) return json({ ok: false, error: "username and password are required." }, 400);
      const valid = await verifyUser(basePath, creds.username, creds.password);
      if (!valid) {
        recordFailure(clientIp);
        return json({ ok: false, error: "Invalid username or password." }, 401);
      }
      clearFailures(clientIp);
      const token = await session.sign(creds.username.trim());
      return json({ ok: true, username: creds.username.trim() }, 200, session.buildSetCookie(token));
    }

    // Known auth path but wrong method.
    return json({ ok: false, error: "Method not allowed." }, 405);
  }

  return { enabled, requireAuth, handleAuthEndpoint };
}

/** True for IPv4/IPv6 loopback, incl. the v4-mapped-in-v6 form Bun may report. */
export function isLoopbackAddress(ip: string | null | undefined): boolean {
  if (!ip) return false;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip.startsWith("127.");
}
