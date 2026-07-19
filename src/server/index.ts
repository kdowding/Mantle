import { existsSync, statSync } from "fs";
import { resolve, join, relative, isAbsolute } from "path";
import type { MantleConfig } from "../config/schema.js";
import type { ToolRegistry } from "../tools/registry.js";
import { handleApi } from "./api.js";
import { createWebSocketHandler } from "./ws.js";
import type { CronRunner } from "../cron/runner.js";
import type { BackgroundTaskRunner } from "../agent/background-runner.js";
import type { SubagentManager } from "../agent/subagent-manager.js";
import type { EnglyphManager } from "../englyph/manager.js";
import type { VoiceManager } from "../voice/manager.js";
import type { RealtimeManager } from "../realtime/manager.js";
import type { LocalModelManager } from "../local/manager.js";
import type { RoomRegistry } from "../rooms/types.js";
import type { IntegrationRegistry } from "../integrations/types.js";
import type { ProvisionManager } from "../provision/manager.js";
import { createSessionAuth } from "../auth/session-token.js";
import { createAuthGate, isLoopbackAddress } from "./auth-gate.js";

export function startServer(
  config: MantleConfig,
  registry: ToolRegistry,
  basePath: string,
  cronRunner?: CronRunner,
  backgroundRunner?: BackgroundTaskRunner,
  englyphManager?: EnglyphManager,
  voiceManager?: VoiceManager,
  realtimeManager?: RealtimeManager,
  subagentManager?: SubagentManager,
  localModelManager?: LocalModelManager,
  rooms?: RoomRegistry,
  integrations?: IntegrationRegistry,
  provisioner?: ProvisionManager,
  // Invoked by POST /api/shutdown so the CLI can stop the server
  // gracefully without having to parse netstat or signal across
  // platforms (Windows doesn't deliver SIGTERM the way POSIX does).
  // The endpoint sends 200 first, then schedules this on a
  // microtask so the response can flush before process.exit fires.
  onShutdownRequested?: () => Promise<void> | void,
) {
  // The UI is the Svelte 5 app in ui/, served as Vite-built static output from
  // ui/dist (gitignored). A fresh checkout has no dist — warn loudly at boot
  // instead of serving unexplained 404s; `bun run ui:build` produces it.
  const uiPath = resolve(basePath, "ui/dist");
  if (!existsSync(join(uiPath, "index.html"))) {
    console.warn(`[MANTLE:server] No built UI at ${uiPath} — run \`bun run ui:build\`. APIs are still up; the browser gets 404s until then.`);
  }
  const wsHandler = createWebSocketHandler(config, registry, backgroundRunner, voiceManager, realtimeManager, subagentManager, localModelManager, integrations);

  // ── TLS / HTTPS ───────────────────────────────────────────────────────
  // When server.tls is set, Bun terminates TLS and we serve HTTPS; the session
  // cookie also gains its Secure flag (passed into createSessionAuth below). A
  // configured-but-missing/incomplete cert is a FATAL boot error — silently
  // serving plain HTTP when you asked for TLS is a downgrade you wouldn't
  // notice. Certs: mkcert (LAN + tailnet multi-SAN) or `tailscale cert`.
  let tlsOption: { cert: ReturnType<typeof Bun.file>; key: ReturnType<typeof Bun.file> } | undefined;
  if (config.server.tls) {
    const { certPath, keyPath } = config.server.tls;
    if (typeof certPath !== "string" || !certPath || typeof keyPath !== "string" || !keyPath) {
      throw new Error(
        `server.tls requires both "certPath" and "keyPath" strings (got certPath=${JSON.stringify(certPath)}, keyPath=${JSON.stringify(keyPath)}).`,
      );
    }
    const resolvedCert = resolve(basePath, certPath);
    const resolvedKey = resolve(basePath, keyPath);
    const missing: string[] = [];
    if (!existsSync(resolvedCert)) missing.push(`cert "${resolvedCert}"`);
    if (!existsSync(resolvedKey)) missing.push(`key "${resolvedKey}"`);
    if (missing.length > 0) {
      throw new Error(
        `server.tls is set but ${missing.join(" and ")} not found — refusing to start rather than silently downgrade to plain HTTP. Fix the path(s), or remove server.tls.`,
      );
    }
    tlsOption = { cert: Bun.file(resolvedCert), key: Bun.file(resolvedKey) };
  }
  const tlsEnabled = tlsOption !== undefined;

  // Inbound-auth gate. Disabled for pure-loopback dev via
  // config.server.auth.enabled=false or MANTLE_AUTH_DISABLED=1.
  const authEnabled = config.server.auth?.enabled !== false && process.env.MANTLE_AUTH_DISABLED !== "1";
  const session = createSessionAuth(basePath, tlsEnabled);
  const gate = createAuthGate(session, authEnabled);
  console.log(`[MANTLE:server] Auth ${authEnabled ? "enabled" : "DISABLED"} · TLS ${tlsEnabled ? "enabled (HTTPS)" : "disabled (HTTP)"}`);
  // The dangerous combination: reachable from the network AND no login wall.
  // isLoopbackAddress doubles as a host-literal check here (0.0.0.0 / a LAN IP
  // → not loopback). A wide-open instance lets anyone on the network drive the
  // agent, its tools, and the shell.
  if (!authEnabled && !isLoopbackAddress(config.server.host)) {
    console.warn(
      `[MANTLE:server] ⚠ DANGER: auth is DISABLED and the server is bound to a non-loopback host (${config.server.host}). ` +
        `Anyone who can reach this host can use the agent and its tools with NO login. ` +
        `Set server.host to 127.0.0.1, or re-enable auth.`,
    );
  }

  const server = Bun.serve({
    port: config.server.port,
    hostname: config.server.host,
    // undefined when no cert configured = plain HTTP (Bun ignores it).
    tls: tlsOption,
    // Cap inbound bodies well below Bun's 128MB default so no endpoint can be
    // made to buffer a huge body pre-allocation (transcribe and upload do
    // req.arrayBuffer()/formData() up front). 64MB clears the largest legit
    // bodies — a 25MB transcribe and a multi-file upload (per-file cap
    // session.maxUploadSizeMB, default 10MB) — with comfortable margin.
    maxRequestBodySize: 64 * 1024 * 1024,

    async fetch(req, server) {
      const url = new URL(req.url);

      // No CORS preflight handler: MANTLE is same-origin (UI + API on one
      // origin; Vite proxies same-origin in dev), so a browser never sends a
      // cross-origin preflight for legitimate use. A cross-origin OPTIONS falls
      // through to the auth gate and gets no Access-Control-* headers, so the
      // browser blocks the follow-up request — which is the intent.

      const clientIp = server.requestIP(req)?.address ?? "unknown";

      // Inbound-auth endpoints (session/login/logout/setup). Handled before
      // the gate — these are how a browser gets its cookie in the first place.
      const authResp = await gate.handleAuthEndpoint(req, url, basePath, clientIp);
      if (authResp) return authResp;

      // WebSocket upgrade — gated. Browsers can't set headers on a WS
      // handshake, so the session cookie (sent automatically same-origin) is
      // what we validate here before allowing the socket.
      if (url.pathname === "/ws") {
        // Origin check (anti-CSWSH): a browser WS handshake DOES send the
        // cookie cross-site (SameSite=Lax covers top-level navigations, and
        // WS upgrades ride a GET) — so a malicious page could otherwise open
        // an authenticated socket. A legitimate browser connection's Origin
        // host always equals the Host it connected to (localhost, LAN IP,
        // tailnet name alike); non-browser clients send no Origin and pass.
        const origin = req.headers.get("origin");
        if (origin) {
          let originHost: string | null = null;
          try {
            originHost = new URL(origin).host;
          } catch { /* malformed Origin → rejected below */ }
          if (!originHost || originHost !== req.headers.get("host")) {
            console.warn(`[MANTLE:server] /ws upgrade rejected: cross-origin (${origin})`);
            return new Response("Forbidden", { status: 403 });
          }
        }
        if (gate.enabled && !(await gate.requireAuth(req))) {
          return new Response("Unauthorized", { status: 401 });
        }
        // No data payload — nothing reads ws.data (handlers get config/
        // registry via createWebSocketHandler's closure).
        const upgraded = server.upgrade(req, { data: {} });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // Shutdown hook for `mantle stop`. Intercepted before the generic
      // API handler so we can fire the graceful-shutdown callback after
      // the response has had a chance to flush.
      if (req.method === "POST" && url.pathname === "/api/shutdown") {
        // Anti-CSRF, same shape as the /ws Origin check: a browser page from
        // another origin could otherwise POST here from the user's own machine
        // (loopback) and stop the server. No Origin header = non-browser
        // caller (curl / the CLI) = fine.
        const origin = req.headers.get("origin");
        if (origin) {
          const originHost = (() => { try { return new URL(origin).host; } catch { return null; } })();
          if (originHost !== url.host) {
            return new Response(JSON.stringify({ ok: false, error: "cross-origin shutdown refused" }), {
              status: 403,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
        // `mantle stop` hits this from loopback without a cookie — allow that.
        // Any non-loopback caller must be authenticated.
        if (
          gate.enabled &&
          !isLoopbackAddress(server.requestIP(req)?.address) &&
          !(await gate.requireAuth(req))
        ) {
          return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (onShutdownRequested) {
          // Defer the callback so the 200 response gets written to the
          // wire before process.exit cuts the connection.
          setTimeout(() => {
            Promise.resolve(onShutdownRequested()).catch((err) => {
              console.warn(`[MANTLE:server] shutdown callback threw: ${err instanceof Error ? err.message : err}`);
            });
          }, 50);
          return new Response(JSON.stringify({ ok: true, shuttingDown: true }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: false, error: "shutdown not wired" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }

      // API routes — gated. (Auth endpoints + loopback shutdown handled above.)
      if (url.pathname.startsWith("/api/")) {
        if (gate.enabled && !(await gate.requireAuth(req))) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        // Error boundary: an unhandled throw must never reach Bun's default
        // 500 handler, which (under `bun run dev`) renders an HTML error page
        // with a stack trace + source paths to whoever made the request. Log
        // the real error server-side; return an opaque JSON 500.
        try {
          return await handleApi(req, url, config, registry, cronRunner, basePath, englyphManager, voiceManager, localModelManager, realtimeManager, rooms, provisioner);
        } catch (err) {
          console.error(
            `[MANTLE:server] unhandled error in ${req.method} ${url.pathname}:`,
            err instanceof Error ? (err.stack ?? err.message) : err,
          );
          return new Response(JSON.stringify({ error: "Internal server error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // Static file serving for UI
      return await serveStatic(url.pathname, uiPath);
    },

    websocket: wsHandler,
  });

  console.log(`[MANTLE:server] Listening on ${tlsEnabled ? "https" : "http"}://${config.server.host}:${config.server.port}`);
  return server;
}

async function serveStatic(pathname: string, uiPath: string): Promise<Response> {
  // Decode percent-encoding first so `..%2f`-style escapes can't slip past
  // the containment check, then default `/` to index.html.
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (rel === "/" || rel === "") rel = "/index.html";

  // Resolve under uiPath, then confirm we didn't climb out of it. Anything
  // that escapes (`../config/schema.ts`, encoded or not) falls back to the
  // SPA shell rather than disclosing files outside the UI dir.
  const candidate = resolve(uiPath, `.${rel.startsWith("/") ? rel : `/${rel}`}`);
  const relToUi = relative(uiPath, candidate);
  const inside = relToUi === "" || (!relToUi.startsWith("..") && !isAbsolute(relToUi));

  // Serve the candidate only if it's a real file inside the UI dir — a directory or a
  // miss falls back to the SPA shell. (statSync is one cheap stat, guarded by
  // the existsSync short-circuit; the win is dropping the blocking full-file
  // read below.)
  const indexHtml = join(uiPath, "index.html");
  const target = inside && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : indexHtml;

  // Bun.file streams the body zero-copy off the event loop instead of a
  // synchronous whole-file read — every asset on a page load hits this path.
  const file = Bun.file(target);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, {
    headers: { "Content-Type": getContentType(target), "Cache-Control": "no-cache" },
  });
}

function getContentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}
