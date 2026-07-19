/**
 * REST endpoints for subscription-auth providers (currently only OpenAI Codex
 * via ChatGPT). The PKCE login itself runs in the mantle process — we open a
 * localhost:1455 server, return the auth URL to the UI, and the user's
 * browser hits the callback when they authorize. UI polls /status to detect
 * completion.
 *
 * Routes:
 *   GET  /api/auth/openai-codex/status   → { loggedIn, email?, plan?, ... }
 *   POST /api/auth/openai-codex/login    → { authUrl, preexisting }
 *   POST /api/auth/openai-codex/logout   → { ok, removed }
 */

import {
  CodexAuthError,
  decodeCodexIdentity,
  deleteCodexTokens,
  isCodexLoginInFlight,
  loadCodexTokens,
  startCodexLogin,
} from "../auth/openai-codex.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleAuthApi(
  req: Request,
  url: URL,
  basePath: string,
): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  if (method === "GET" && path === "/api/auth/openai-codex/status") {
    return statusResponse(basePath);
  }

  if (method === "POST" && path === "/api/auth/openai-codex/login") {
    try {
      const result = await startCodexLogin({ basePath });
      return json({
        authUrl: result.authUrl,
        preexisting: result.preexisting,
      });
    } catch (err) {
      const message =
        err instanceof CodexAuthError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      return json({ error: message }, 500);
    }
  }

  if (method === "POST" && path === "/api/auth/openai-codex/logout") {
    const removed = deleteCodexTokens(basePath);
    return json({ ok: true, removed });
  }

  return json({ error: "Not found" }, 404);
}

async function statusResponse(basePath: string): Promise<Response> {
  const tokens = loadCodexTokens(basePath);
  if (!tokens) {
    return json({
      provider: "openai-codex",
      loggedIn: false,
      loginInFlight: isCodexLoginInFlight(),
    });
  }
  let identity;
  try {
    identity = decodeCodexIdentity(tokens.access);
  } catch (err) {
    // Tokens present but JWT is malformed or missing chatgpt_account_id.
    return json({
      provider: "openai-codex",
      loggedIn: false,
      loginInFlight: isCodexLoginInFlight(),
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Best-effort live usage fetch. wham/usage returns the same data
  // chatgpt.com would show in its subscription/codex usage UI: percent of
  // 5h and 7d rolling windows consumed, plus reset countdowns. If the call
  // fails (network glitch, expired access token before refresh, OpenAI
  // rate-limiting), the status response still returns the basic identity
  // — usage just gets omitted. 3s timeout so a slow chatgpt.com doesn't
  // make the auth row feel sluggish.
  const usage = await fetchCodexUsage(tokens.access, identity.accountId);

  return json({
    provider: "openai-codex",
    loggedIn: true,
    loginInFlight: isCodexLoginInFlight(),
    email: identity.email,
    plan: identity.planType,
    accountId: identity.accountId,
    expiresAt: tokens.expires,
    usage,
  });
}

interface CodexUsageSnapshot {
  primaryUsedPercent: number | null;
  primaryWindowSeconds: number | null;
  primaryResetAfterSeconds: number | null;
  secondaryUsedPercent: number | null;
  secondaryWindowSeconds: number | null;
  secondaryResetAfterSeconds: number | null;
}

async function fetchCodexUsage(
  accessToken: string,
  accountId: string,
): Promise<CodexUsageSnapshot | undefined> {
  try {
    const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "ChatGPT-Account-Id": accountId,
        originator: "mantle",
        "User-Agent": "mantle/0.1.0",
      },
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return undefined;
    const data = (await resp.json()) as {
      rate_limit?: {
        primary_window?: {
          used_percent?: number;
          limit_window_seconds?: number;
          reset_after_seconds?: number;
        };
        secondary_window?: {
          used_percent?: number;
          limit_window_seconds?: number;
          reset_after_seconds?: number;
        };
      };
    };
    const p = data.rate_limit?.primary_window;
    const s = data.rate_limit?.secondary_window;
    return {
      primaryUsedPercent: p?.used_percent ?? null,
      primaryWindowSeconds: p?.limit_window_seconds ?? null,
      primaryResetAfterSeconds: p?.reset_after_seconds ?? null,
      secondaryUsedPercent: s?.used_percent ?? null,
      secondaryWindowSeconds: s?.limit_window_seconds ?? null,
      secondaryResetAfterSeconds: s?.reset_after_seconds ?? null,
    };
  } catch {
    return undefined;
  }
}
