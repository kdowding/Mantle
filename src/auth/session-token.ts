/**
 * Stateless signed session tokens + cookie helpers for inbound auth.
 *
 * Why cookies, not bearer tokens: the agent loop runs over the /ws
 * WebSocket, and browsers cannot set custom headers on a WS upgrade. A
 * same-origin HttpOnly cookie rides along automatically on both /api/* and
 * the /ws upgrade, so one mechanism covers every gated surface.
 *
 * Token = base64url(JSON payload) + "." + base64url(HMAC-SHA256 over the
 * payload). Stateless: no server-side session table. Survives restarts (the
 * signing secret is persisted). "Log out everywhere" = rotate the secret
 * (delete .mantle/auth/session-secret). Individual logout clears the cookie.
 *
 * Cookie flags: HttpOnly (no JS access), SameSite=Lax (initial document load
 * carries it so there's no login flash; cross-site fetch/XHR/WS do NOT, which
 * is the CSRF protection). The Secure flag is added when the server serves
 * HTTPS (config.server.tls set; startServer passes it in) and omitted over
 * plain HTTP, where a Secure cookie would never be sent and would break login.
 * On plain LAN without TLS the cookie is sniffable — that's the gap enabling
 * server.tls closes.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import { ensureSecureDir } from "./secure-dir.js";

const COOKIE_NAME = "mantle_session";
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SECRET_BYTES = 32;

interface TokenPayload {
  u: string; // username
  exp: number; // epoch ms
}

function secretPath(basePath: string): string {
  return resolve(basePath, ".mantle", "auth", "session-secret");
}

/**
 * Load the HMAC signing secret, generating + persisting one (mode 0600) on
 * first run. A too-short or unreadable file is regenerated — which
 * invalidates any outstanding tokens, the safe failure mode.
 */
function getOrCreateSecretBytes(basePath: string): Uint8Array {
  const p = secretPath(basePath);
  // Runs at boot, so this also re-asserts the Windows ACL on auth dirs
  // created by older versions (mode bits alone are a no-op on win32).
  ensureSecureDir(resolve(basePath, ".mantle", "auth"));
  if (existsSync(p)) {
    try {
      const buf = Buffer.from(readFileSync(p, "utf-8").trim(), "base64");
      if (buf.length >= SECRET_BYTES) return new Uint8Array(buf);
    } catch {
      // fall through to regenerate
    }
  }
  const bytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(bytes);
  writeFileSync(p, Buffer.from(bytes).toString("base64"), { encoding: "utf-8", mode: 0o600 });
  return bytes;
}

/**
 * Invalidate all outstanding session cookies by deleting the signing secret —
 * getOrCreateSecretBytes regenerates a fresh one on next load. A running server
 * caches the key in memory at startup, so this takes full effect on the next
 * start; callers (mantle user passwd / reset) should say so.
 */
export function rotateSessionSecret(basePath: string): void {
  const p = secretPath(basePath);
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {
    // Best-effort — an unreadable secret is also regenerated on next load.
  }
}

function b64url(data: ArrayBuffer | Uint8Array): string {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  return Buffer.from(u8).toString("base64url");
}

export interface SessionAuth {
  readonly cookieName: string;
  sign(username: string, ttlMs?: number): Promise<string>;
  /** Returns the validated payload, or null if the token is missing/forged/expired. */
  verify(token: string | null): Promise<{ username: string } | null>;
  buildSetCookie(token: string, ttlMs?: number): string;
  buildClearCookie(): string;
}

export function createSessionAuth(basePath: string, secure = false): SessionAuth {
  const secret = getOrCreateSecretBytes(basePath);
  const encoder = new TextEncoder();

  // Import the CryptoKey lazily + once, so callers stay synchronous to
  // construct (startServer doesn't have to become async just for this).
  let keyPromise: Promise<CryptoKey> | null = null;
  const getKey = (): Promise<CryptoKey> =>
    (keyPromise ??= crypto.subtle.importKey(
      "raw",
      secret as unknown as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    ));

  async function sign(username: string, ttlMs = DEFAULT_TTL_MS): Promise<string> {
    const payload: TokenPayload = { u: username, exp: Date.now() + ttlMs };
    const body = b64url(encoder.encode(JSON.stringify(payload)));
    const sig = await crypto.subtle.sign("HMAC", await getKey(), encoder.encode(body));
    return `${body}.${b64url(sig)}`;
  }

  async function verify(token: string | null): Promise<{ username: string } | null> {
    if (!token) return null;
    const dot = token.indexOf(".");
    if (dot <= 0 || dot === token.length - 1) return null;
    const body = token.slice(0, dot);
    const sigPart = token.slice(dot + 1);

    let sigBytes: Buffer;
    try {
      sigBytes = Buffer.from(sigPart, "base64url");
    } catch {
      return null;
    }
    // crypto.subtle.verify does a constant-time comparison internally.
    const ok = await crypto.subtle.verify(
      "HMAC",
      await getKey(),
      sigBytes as unknown as BufferSource,
      encoder.encode(body),
    );
    if (!ok) return null;

    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as TokenPayload;
      if (typeof payload.u !== "string" || !payload.u) return null;
      if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
      return { username: payload.u };
    } catch {
      return null;
    }
  }

  // Appended when the server is serving HTTPS (createSessionAuth's `secure`
  // arg). Omitted on plain HTTP — browsers drop a Secure cookie on an http://
  // origin, which would silently break login.
  const secureFlag = secure ? "; Secure" : "";

  function buildSetCookie(token: string, ttlMs = DEFAULT_TTL_MS): string {
    const maxAge = Math.floor(ttlMs / 1000);
    return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureFlag}`;
  }

  function buildClearCookie(): string {
    return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureFlag}`;
  }

  return { cookieName: COOKIE_NAME, sign, verify, buildSetCookie, buildClearCookie };
}

/** Pull a single cookie value out of a raw Cookie header. */
export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}
