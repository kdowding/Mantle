#!/usr/bin/env bun
/**
 * rev://MANTLE CLI
 *
 * Usage:
 *   mantle start     — Start MANTLE in the background
 *   mantle stop      — Stop MANTLE
 *   mantle restart   — Restart MANTLE
 *   mantle status    — Check if MANTLE is running
 *   mantle dev       — Start in foreground (for development)
 */

import { resolve, basename } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { planLaunch } from "./launch-command.js";
import {
  CodexAuthError,
  decodeCodexIdentity,
  deleteCodexTokens,
  getCodexTokenPath,
  loadCodexTokens,
  loginCodex,
  tryOpenBrowser,
} from "./auth/openai-codex.js";
import { loadConfig } from "./config/loader.js";
import { loadUsers, changePassword } from "./auth/credentials.js";
import {
  loadRegistry,
  removeModel,
  resolveModelFile,
  resolveModelsDir,
  updateModel,
} from "./local/registry.js";
// Shared model-pull engine — the CLI and the UI/REST pull path both drive
// this so the download + register logic can't drift between them.
import { pullModel, fmtBytes } from "./local/pull.js";
// Shared build-if-stale for the UI — the detached server serves ui/dist as-is
// and won't rebuild on its own, so `start` runs this first.
import { ensureUiBuilt } from "./ui-build.js";

const BASE_PATH = resolve(import.meta.dir, "..");
const PID_FILE = resolve(BASE_PATH, ".mantle", "mantle.pid");

// Server-control target (start/stop/status probe our own loopback server).
// Read straight from .mantle/config.json — NOT loadConfig(), which has boot
// side effects (mkdir, migrations, logging) we don't want from a status probe.
// Honors a custom server.port and switches to https when server.tls is set; we
// always target loopback (config.server.host may be 0.0.0.0) and skip cert
// verification below because it's a same-machine call to our own cert.
function readServerControl(): { origin: string; tls: boolean } {
  let port = 3333;
  let tls = false;
  try {
    const cfgPath = resolve(BASE_PATH, ".mantle", "config.json");
    if (existsSync(cfgPath)) {
      const raw = JSON.parse(readFileSync(cfgPath, "utf-8")) as { server?: { port?: unknown; tls?: unknown } };
      if (typeof raw.server?.port === "number" && raw.server.port > 0) port = raw.server.port;
      // Truthiness must match server/index.ts (`if (config.server.tls)`):
      // `"tls": false` / null is NOT https — a `!= null` check here made
      // `mantle stop` probe https against an http server, report "Not
      // running", and delete the PID while the server kept running.
      tls = Boolean(raw.server?.tls);
    }
  } catch {
    // Unreadable / invalid config — fall back to the HTTP default port.
  }
  return { origin: `${tls ? "https" : "http"}://127.0.0.1:${port}`, tls };
}
const CONTROL = readServerControl();

// fetch() against our own loopback server, https-aware. Skips cert
// verification (Bun's `tls` fetch option) for a self-signed / mkcert cert —
// safe for a same-machine control call; harmless over plain http.
function controlFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const opts: Record<string, unknown> = { ...init };
  if (CONTROL.tls) opts.tls = { rejectUnauthorized: false };
  return fetch(`${CONTROL.origin}${path}`, opts as RequestInit);
}

const command = process.argv[2];

switch (command) {
  case "start":
    await start();
    break;
  case "stop":
    await stop();
    break;
  case "restart":
    await stop();
    // Small delay to let the port free up
    await new Promise((r) => setTimeout(r, 1500));
    await start();
    break;
  case "status":
    await status();
    break;
  case "dev":
    console.log("[MANTLE] Starting in dev mode (foreground)...");
    await import("./index.js");
    break;
  case "auth":
    await handleAuth(process.argv.slice(3));
    break;
  case "user":
    await handleUser(process.argv.slice(3));
    break;
  case "pull":
    await pull(process.argv.slice(3));
    break;
  case "models":
    await models(process.argv.slice(3));
    break;
  case "integrations":
    await handleIntegrations(process.argv.slice(3));
    break;
  default:
    console.log(`rev://MANTLE CLI

Usage:
  mantle start                    Start MANTLE in the background
  mantle stop                     Stop MANTLE
  mantle restart                  Restart MANTLE
  mantle status                   Check if MANTLE is running
  mantle dev                      Start in foreground (dev mode)

  mantle auth login [provider]    Log in to a subscription-auth provider
                                  (default: openai-codex)
  mantle auth logout [provider]   Delete saved credentials
  mantle auth status [provider]   Show login + identity for a provider

  mantle user list                Show the configured login account
  mantle user passwd              Change the login password (hidden prompt)
  mantle user reset               Wipe the account → next visit is first-run setup
                                  (--keep-sessions to leave existing cookies valid)

  mantle pull <spec>              Download a GGUF model from HuggingFace into
                                  the local runtime. <spec> is a full
                                  huggingface.co URL, or org/repo[:quant]
                                  (e.g. bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M),
                                  or org/repo:file.gguf. Flags: --id <name>,
                                  --revision <rev>, --no-tools (disable tool
                                  calls for models that can't handle them).
  mantle models [list]            List locally-registered models.
  mantle models rm <id> [--file]  Remove a model (--file also deletes the GGUF).
  mantle models set <id> [flags]  Edit a model. Instant (next message):
                                  --temp F, --top-p F, --top-k N, --min-p F,
                                  --repeat-penalty F, --max-tokens N,
                                  --tools off|core|all, --reasoning on|off.
                                  Reload-on-change: --ctx N, --ngl N, --threads N.
                                  Also --default.
`);
    break;
}

async function isServerUp(): Promise<boolean> {
  try {
    // Probe the PUBLIC auth-session endpoint: it returns 200 without a login
    // cookie, whereas /api/config now sits behind the auth gate and would 401
    // even on a healthy server (which used to make stop/status/restart think
    // the server was down). A resolved response = the server is up.
    const resp = await controlFetch("/api/auth/session");
    return resp.ok;
  } catch {
    return false;
  }
}

async function start() {
  if (await isServerUp()) {
    console.log(`[MANTLE] Already running at ${CONTROL.origin}`);
    return;
  }

  // Rebuild the UI if its source changed since the last build — the detached
  // server serves ui/dist as-is and won't rebuild on its own. Stale → build now
  // (foreground, visible); fresh → instant. A build failure is non-fatal: warn
  // and start anyway, since the previous dist (if any) still serves.
  try {
    await ensureUiBuilt(BASE_PATH);
  } catch (err) {
    console.error(
      `[MANTLE] UI build failed — starting with the existing build. ${err instanceof Error ? err.message : err}`,
    );
  }

  console.log("[MANTLE] Starting...");

  // Platform-specific detached spawn, planned by the pure launch module
  // (Windows: own console window; POSIX: nohup + .mantle/mantle.log).
  // Either way the server writes its own PID file at startup — no need to
  // capture the spawn PID here.
  // Fresh clone: .mantle/ may not exist yet, and both branches write into it
  // (launcher.cmd / mantle.log) before the server's own boot creates it.
  mkdirSync(resolve(BASE_PATH, ".mantle"), { recursive: true });
  const plan = planLaunch({
    platform: process.platform,
    bunPath: process.execPath,
    entryScript: resolve(BASE_PATH, "src/index.ts"),
    mantleDir: resolve(BASE_PATH, ".mantle"),
  });
  if (plan.launcherFile) writeFileSync(plan.launcherFile.path, plan.launcherFile.content, "utf-8");

  const child = Bun.spawn(plan.argv, {
    cwd: BASE_PATH,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env },
  });
  // Let the CLI exit while the detached server keeps running.
  child.unref();
  if (plan.logPath) console.log(`[MANTLE] Logs: ${plan.logPath}`);

  // Wait for server to respond
  let started = false;
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await isServerUp()) {
      started = true;
      break;
    }
  }

  if (started) {
    console.log(`[MANTLE] Running at ${CONTROL.origin}`);
  } else {
    console.error("[MANTLE] Failed to start — server didn't respond after 25s");
  }
}

async function stop() {
  if (!(await isServerUp())) {
    console.log("[MANTLE] Not running");
    cleanPid();
    return;
  }

  console.log("[MANTLE] Stopping...");

  // Primary path: ask the server to shut itself down via its own
  // graceful-shutdown handler. That tears down Englyph/voice/MCP
  // children cleanly, persists in-flight state, and removes the PID
  // file. Cross-platform — no signal/netstat shenanigans.
  let requested = false;
  try {
    const resp = await controlFetch("/api/shutdown", { method: "POST" });
    requested = resp.ok;
  } catch {
    // Server didn't accept the shutdown request — fall back to PID kill
    requested = false;
  }

  // Wait for the server to actually go down. The shutdown handler does
  // some teardown work (~500ms abort grace + englyph/voice cleanup),
  // so give it a few seconds.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!(await isServerUp())) {
      console.log("[MANTLE] Stopped");
      cleanPid();
      return;
    }
  }

  // Fallback: server didn't respond to the graceful shutdown. Kill by
  // PID file directly. This skips the orderly child-process teardown,
  // so englyph/voice processes may be orphaned — diagnose later if it
  // happens often.
  const pid = readPid();
  if (pid && !requested) {
    console.warn(`[MANTLE] Graceful shutdown failed; force-killing PID ${pid}`);
    try {
      process.kill(pid);
      await new Promise((r) => setTimeout(r, 500));
      if (!(await isServerUp())) {
        console.log("[MANTLE] Stopped (forced)");
        cleanPid();
        return;
      }
    } catch (err) {
      console.warn(`[MANTLE]   kill failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.error(`[MANTLE] Failed to stop. PID file: ${PID_FILE}`);
}

async function status() {
  const up = await isServerUp();
  const pid = readPid();
  if (up) {
    const pidStr = pid ? ` (pid ${pid})` : "";
    console.log(`[MANTLE] Running at ${CONTROL.origin}${pidStr}`);
  } else {
    console.log("[MANTLE] Not running");
    cleanPid();
  }
}

function readPid(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const raw = readFileSync(PID_FILE, "utf-8").trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function cleanPid() {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {}
}

// ---- auth subcommands ---------------------------------------------------

async function handleAuth(args: string[]) {
  // Declared inside the function to dodge TDZ — the switch above awaits
  // handleAuth before module init reaches any top-level consts placed below.
  const supportedProviders = new Set(["openai-codex"]);
  const sub = args[0];
  const provider = args[1] ?? "openai-codex";
  if (!sub) {
    console.log(`Usage:
  mantle auth login [provider]
  mantle auth logout [provider]
  mantle auth status [provider]

Supported providers: ${Array.from(supportedProviders).join(", ")}`);
    return;
  }
  if (!supportedProviders.has(provider)) {
    console.error(
      `[auth] Unknown provider: ${provider}. Supported: ${Array.from(supportedProviders).join(", ")}`,
    );
    process.exit(1);
  }

  switch (sub) {
    case "login":
      await authLogin(provider);
      break;
    case "logout":
      authLogout(provider);
      break;
    case "status":
      authStatus(provider);
      break;
    default:
      console.error(`[auth] Unknown subcommand: ${sub}`);
      process.exit(1);
  }
}

async function authLogin(provider: string) {
  if (provider !== "openai-codex") return; // gated above
  console.log("[auth] Logging in to OpenAI Codex (ChatGPT subscription)…\n");
  try {
    const tokens = await loginCodex({
      basePath: BASE_PATH,
      onAuthUrl: (url) => {
        console.log("Opening browser to:");
        console.log(`  ${url}\n`);
        console.log("If the browser doesn't open, copy/paste the URL above.\n");
        tryOpenBrowser(url);
        console.log(`Waiting for browser callback on http://localhost:1455 …`);
      },
    });
    const identity = decodeCodexIdentity(tokens.access);
    const expiresAt = new Date(tokens.expires).toISOString();
    console.log(`\n[auth] ✓ Logged in as ${identity.email ?? identity.accountId}`);
    console.log(`       account:  ${identity.accountId}`);
    console.log(`       plan:     ${identity.planType ?? "(unknown)"}`);
    console.log(`       expires:  ${expiresAt}`);
    console.log(`       tokens:   ${getCodexTokenPath(BASE_PATH)}`);
  } catch (err) {
    if (err instanceof CodexAuthError) {
      console.error(`\n[auth] Login failed (${err.code}): ${err.message}`);
    } else {
      console.error(`\n[auth] Login failed: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  }
}

function authLogout(provider: string) {
  if (provider !== "openai-codex") return;
  const removed = deleteCodexTokens(BASE_PATH);
  if (removed) {
    console.log(`[auth] Removed ${getCodexTokenPath(BASE_PATH)}`);
  } else {
    console.log("[auth] No saved credentials to remove.");
  }
}

function authStatus(provider: string) {
  if (provider !== "openai-codex") return;
  const tokens = loadCodexTokens(BASE_PATH);
  if (!tokens) {
    console.log("[auth] openai-codex: not logged in");
    console.log("       Run `mantle auth login` to authenticate.");
    return;
  }
  let identity;
  try {
    identity = decodeCodexIdentity(tokens.access);
  } catch (err) {
    console.log(`[auth] openai-codex: tokens present but JWT invalid: ${err instanceof Error ? err.message : err}`);
    return;
  }
  const remainingMs = tokens.expires - Date.now();
  const remainingMin = Math.round(remainingMs / 60000);
  const status = remainingMs > 0 ? `expires in ${remainingMin} min` : "EXPIRED (will refresh on next use)";
  console.log("[auth] openai-codex: logged in");
  console.log(`       email:    ${identity.email ?? "(none)"}`);
  console.log(`       account:  ${identity.accountId}`);
  console.log(`       plan:     ${identity.planType ?? "(unknown)"}`);
  console.log(`       access:   ${status}`);
  console.log(`       tokens:   ${getCodexTokenPath(BASE_PATH)}`);
}

// ---- integrations subcommands (mantle integrations) ---------------------
// Connect / inspect external-service credentials per agent. Writes the broker
// store directly (.mantle/auth/integrations/), server up or down — same
// direct-write discipline as `mantle user`/`mantle auth`; a running server
// reads the store live, so no restart is needed after a connect.

function defaultAgentId(): string | undefined {
  try {
    const cfgPath = resolve(BASE_PATH, ".mantle", "config.json");
    if (!existsSync(cfgPath)) return undefined;
    const raw = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
      defaultAgent?: string;
      agents?: Array<{ id?: string }>;
    };
    return raw.defaultAgent || raw.agents?.[0]?.id || undefined;
  } catch {
    return undefined;
  }
}

function readIntegrationCreds(id: string): { clientId?: string; clientSecret?: string } | undefined {
  try {
    const cfgPath = resolve(BASE_PATH, ".mantle", "config.json");
    if (!existsSync(cfgPath)) return undefined;
    const raw = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
      integrations?: Record<string, { clientId?: string; clientSecret?: string }>;
    };
    return raw.integrations?.[id];
  } catch {
    return undefined;
  }
}

async function handleIntegrations(args: string[]) {
  const { IntegrationBroker } = await import("./auth/integration-broker.js");
  const { GitHubIntegration } = await import("./integrations/github/index.js");
  const { GmailIntegration } = await import("./integrations/gmail/index.js");
  type Integration = import("./integrations/types.js").Integration;
  const broker = new IntegrationBroker(BASE_PATH);
  // Known integrations — mirror src/index.ts registration.
  const integrations: Record<string, Integration> = {
    github: new GitHubIntegration(broker, BASE_PATH),
    gmail: new GmailIntegration(broker, BASE_PATH),
  };

  const sub = args[0];
  if (!sub || sub === "help") {
    console.log(`Usage:
  mantle integrations list
  mantle integrations status                  [--agent <id>]
  mantle integrations connect <id> <token>    [--agent <id>]
  mantle integrations disconnect <id>         [--agent <id>]

Known integrations: ${Object.keys(integrations).join(", ")}
Tokens are stored per-agent under .mantle/auth/integrations/ (mode 0600).
A running server picks up connect/disconnect live - no restart needed.`);
    return;
  }

  if (sub === "list") {
    for (const [id, integ] of Object.entries(integrations)) {
      console.log(`- ${id} (${integ.label}) - auth: ${integ.auth.kind}`);
    }
    return;
  }

  // The remaining subcommands act on one agent.
  const agentFlag = args.indexOf("--agent");
  const agentId = (agentFlag >= 0 ? args[agentFlag + 1] : undefined) ?? defaultAgentId();
  if (!agentId) {
    console.error("[integrations] No agent resolved - pass --agent <id> (or set defaultAgent in config).");
    process.exit(1);
  }

  switch (sub) {
    case "status": {
      for (const id of Object.keys(integrations)) {
        const info = broker.connectionInfo(id, agentId);
        if (!info) {
          console.log(`- ${id}: not connected (agent ${agentId})`);
          continue;
        }
        console.log(
          `- ${id}: connected as ${info.account ?? "?"} - write:${info.writeEnabled ? "on" : "off"}` +
            ` - scopes: ${info.scopes.join(", ") || "(none reported)"}`,
        );
      }
      return;
    }
    case "connect": {
      const id = args[1];
      if (!id || id.startsWith("--")) {
        console.error("Usage: mantle integrations connect <id> [<token>] [--write] [--agent <id>]");
        process.exit(1);
      }
      const integ = integrations[id];
      if (!integ) {
        console.error(`[integrations] Unknown integration: ${id}. Known: ${Object.keys(integrations).join(", ")}`);
        process.exit(1);
      }

      if (integ.auth.kind === "oauth2") {
        const oauthSpec = integ.auth;
        const creds = readIntegrationCreds(id);
        if (!creds?.clientId) {
          console.error(
            `[integrations] ${id} needs your OAuth app credentials. Add them to .mantle/config.json:\n` +
              `  "integrations": { "${id}": { "clientId": "...", "clientSecret": "..." } }\n` +
              `Create a Desktop-app OAuth client in the provider's console (see the integration docs).`,
          );
          process.exit(1);
        }
        const includeWrite = args.includes("--write");
        try {
          const { tryOpenBrowser } = await import("./auth/openai-codex.js");
          const info = await broker.connectOAuth({
            integrationId: id,
            agentId,
            spec: oauthSpec,
            creds: { clientId: creds.clientId, clientSecret: creds.clientSecret },
            includeWrite,
            onAuthUrl: (url) => {
              console.log(`[integrations] Opening browser to authorize ${id}:`);
              console.log(`  ${url}\n`);
              tryOpenBrowser(url);
              console.log("Waiting for the browser callback on http://127.0.0.1:1456 ...");
            },
          });
          console.log(`[integrations] OK - ${id} connected for agent ${agentId}${info.account ? ` as ${info.account}` : ""}`);
          console.log(
            `       write:  ${info.writeEnabled ? "enabled" : "read-only"}` +
              `${includeWrite && !info.writeEnabled ? " (write scope not granted)" : ""}`,
          );
          if (info.scopes.length) console.log(`       scopes: ${info.scopes.join(", ")}`);
        } catch (e) {
          console.error(`[integrations] connect failed: ${e instanceof Error ? e.message : String(e)}`);
          process.exit(1);
        }
        return;
      }

      // PAT integrations: paste the token.
      const token = args[2];
      if (!token || token.startsWith("--")) {
        console.error(`Usage: mantle integrations connect ${id} <token> [--agent <id>]`);
        process.exit(1);
      }
      try {
        console.log(`[integrations] Verifying ${id} token...`);
        const info = integ.verifyToken
          ? await integ.verifyToken(token)
          : { scopes: [] as string[], writeEnabled: false };
        broker.connect(id, agentId, token, info);
        console.log(`[integrations] OK - ${id} connected for agent ${agentId}${info.account ? ` as ${info.account}` : ""}`);
        console.log(`       write:  ${info.writeEnabled ? "enabled" : "read-only"}`);
        if (info.scopes.length) console.log(`       scopes: ${info.scopes.join(", ")}`);
      } catch (e) {
        console.error(`[integrations] connect failed: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
      return;
    }
    case "disconnect": {
      const id = args[1];
      if (!id || id.startsWith("--")) {
        console.error("Usage: mantle integrations disconnect <id> [--agent <id>]");
        process.exit(1);
      }
      const removed = broker.disconnect(id, agentId);
      console.log(
        removed
          ? `[integrations] Disconnected ${id} for agent ${agentId}.`
          : `[integrations] ${id} was not connected for agent ${agentId}.`,
      );
      return;
    }
    default:
      console.error(`[integrations] Unknown subcommand: ${sub}`);
      process.exit(1);
  }
}

// ---- user account subcommands (mantle user) -----------------------------
// Inbound-login account management. Works whether or not the server is
// running — it reads/writes .mantle/auth directly. hasAnyUser() reads live,
// so a reset takes effect on the next page load with no restart.
async function handleUser(args: string[]) {
  const sub = args[0];
  switch (sub) {
    case "list":
      userList();
      break;
    case "passwd":
      await userPasswd();
      break;
    case "reset":
      userReset(args.slice(1));
      break;
    default:
      console.log(`Usage:
  mantle user list        Show the configured login account
  mantle user passwd      Change the account password (hidden prompt)
  mantle user reset       Wipe the account → next visit is first-run setup
                          (--keep-sessions to leave existing cookies valid)`);
      if (sub) process.exit(1);
  }
}

function userList() {
  const users = loadUsers(BASE_PATH);
  if (users.length === 0) {
    console.log("[user] No account configured — the first visit will show the setup screen.");
    return;
  }
  console.log(`[user] ${users.length} account${users.length === 1 ? "" : "s"}:`);
  for (const u of users) {
    console.log(`       ${u.username}  (created ${new Date(u.createdAt).toISOString().slice(0, 10)})`);
  }
}

async function userPasswd() {
  const users = loadUsers(BASE_PATH);
  if (users.length === 0) {
    console.log("[user] No account yet — open the app and use the first-run setup screen.");
    return;
  }
  const username = users[0].username;
  console.log(`[user] Changing password for "${username}".`);
  let pw: string;
  let confirm: string;
  try {
    pw = await readHidden("       New password: ");
    confirm = await readHidden("       Confirm:      ");
  } catch {
    console.log("[user] Cancelled.");
    process.exit(1);
  }
  if (pw !== confirm) {
    console.error("[user] Passwords do not match.");
    process.exit(1);
  }
  const result = await changePassword(BASE_PATH, username, pw);
  if (!result.ok) {
    console.error(`[user] ${result.error}`);
    process.exit(1);
  }
  console.log(`[user] ✓ Password updated for "${username}".`);
  console.log("       The session signing secret was rotated — existing login");
  console.log("       cookies are invalidated on the next mantle restart.");
}

function userReset(args: string[]) {
  const keepSessions = args.includes("--keep-sessions");
  const dir = resolve(BASE_PATH, ".mantle", "auth");
  const usersFile = resolve(dir, "users.json");
  const secretFile = resolve(dir, "session-secret");

  if (existsSync(usersFile)) {
    unlinkSync(usersFile);
    console.log(`[user] Removed ${usersFile}`);
  } else {
    console.log("[user] No account file to remove (already at first-run state).");
  }

  if (!keepSessions && existsSync(secretFile)) {
    unlinkSync(secretFile);
    console.log("[user] Rotated the session secret — existing login cookies are now invalid.");
  }

  console.log('[user] Done. The next page load shows the "Create your login" setup screen.');
}

// Read a line from stdin without echoing it (password entry). On a TTY this
// uses raw mode; when stdin is piped (tests/scripts) it just reads the line.
function readHidden(promptText: string): Promise<string> {
  return new Promise((resolvePw, reject) => {
    const stdin = process.stdin;
    process.stdout.write(promptText);
    const isTty = Boolean(stdin.isTTY);
    if (isTty) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      if (isTty) stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === "\n" || ch === "\r") {
          cleanup();
          process.stdout.write("\n");
          resolvePw(buf);
          return;
        } else if (code === 3) { // Ctrl-C
          cleanup();
          process.stdout.write("\n");
          reject(new Error("cancelled"));
          return;
        } else if (code === 127 || code === 8) { // DEL / backspace
          buf = buf.slice(0, -1);
        } else if (code >= 32) {
          buf += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

// ---- local model subcommands (mantle pull / mantle models) --------------
// `mantle pull <spec>` is a pure download+register op — it works whether or
// not the server is running (like `mantle auth`). The running server reads
// the registry live, so a freshly-pulled model surfaces in the UI without a
// restart.

function parseOnOff(v: string | undefined): boolean {
  return v === "on" || v === "true" || v === "1" || v === "yes" || v === "enable";
}

async function pull(args: string[]) {
  let spec = "";
  let idOverride: string | undefined;
  let revision = "main";
  let noTools = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--id") idOverride = args[++i];
    else if (a === "--revision" || a === "--rev") revision = args[++i] ?? "main";
    else if (a === "--no-tools") noTools = true;
    else if (!a.startsWith("--")) spec = a;
  }
  if (!spec) {
    console.error(
      "Usage: mantle pull <hf-url | org/repo[:quant] | org/repo:file.gguf> [--id <name>] [--revision <rev>]",
    );
    process.exit(1);
  }

  const config = loadConfig(BASE_PATH);
  if (!config.localModels.enabled) {
    console.warn("[pull] note: localModels.enabled is false — pulling anyway, but flip it on to use the model.");
  }
  const modelsDirAbs = resolveModelsDir(config.basePath, config.localModels.modelsDir);
  const token =
    config.localModels.hfToken || process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || undefined;

  // Delegate resolve + download + register to the shared engine so the CLI
  // and the UI/REST pull path stay identical. Render its progress stream as
  // the familiar single-line `[pull]` readout.
  let lastFile = "";
  let result: Awaited<ReturnType<typeof pullModel>>;
  try {
    result = await pullModel(
      { modelsDirAbs, hfToken: token, spec, idOverride, revision, noTools },
      (p) => {
        if (p.phase === "resolving") {
          process.stderr.write(`[pull] resolving ${p.spec ?? spec}…\n`);
        } else if (p.phase === "downloading") {
          if (p.file && p.file !== lastFile) {
            lastFile = p.file;
            if ((p.fileCount ?? 1) > 1) {
              process.stderr.write(`\n[pull] file ${p.fileIndex}/${p.fileCount}: ${p.file}\n`);
            }
          }
          const recv = p.receivedBytes ?? 0;
          const total = p.totalBytes ?? 0;
          const pct = total ? `${((recv / total) * 100).toFixed(1)}%` : fmtBytes(recv);
          process.stderr.write(
            `\r[pull] ${p.file ?? ""}  ${pct}  ${fmtBytes(recv)}${total ? `/${fmtBytes(total)}` : ""}  ${fmtBytes(p.speedBytesPerSec ?? 0)}/s    `,
          );
        } else if (p.phase === "registering") {
          process.stderr.write(`\n[pull] registering…\n`);
        }
      },
    );
  } catch (err) {
    console.error(`\n[pull] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Read the entry back for the summary (quant / reasoning / default flag) —
  // pullModel persisted them; this keeps the CLI's existing readout.
  const { modelId: id, bytes } = result;
  const reg = loadRegistry(modelsDirAbs);
  const entry = reg.models.find((m) => m.id === id);
  console.log(`\n[pull] ✓ registered "${id}"${reg.defaultModelId === id ? " (default)" : ""}`);
  console.log(`       size:  ${fmtBytes(bytes)}${entry?.quant ? `  quant ${entry.quant}` : ""}`);
  console.log(
    `       tools: ${noTools ? "off (--no-tools)" : "core (curated subset; `mantle models set " + id + " --tools all` for everything)"}`,
  );
  if (entry?.reasoning) {
    console.log(`       flagged as a reasoning model (inline <think> parsing on) — \`mantle models set ${id} --reasoning off\` if wrong.`);
  }

  const binPath = config.localModels.binaryPath.startsWith(".")
    ? resolve(BASE_PATH, config.localModels.binaryPath)
    : config.localModels.binaryPath;
  if (!existsSync(binPath)) {
    console.log(`\n[pull] ⚠ llama-server not found at ${binPath}`);
    console.log(`       Download the build for your GPU (Windows + NVIDIA: the -bin-win-cuda-x64 release) from`);
    console.log(`       https://github.com/ggml-org/llama.cpp/releases and unzip llama-server.exe + DLLs there.`);
  } else {
    console.log(`\n[pull] Ready — pick "${id}" under the Local provider in the UI.`);
  }
}

async function models(args: string[]) {
  const sub = args[0] ?? "list";
  const config = loadConfig(BASE_PATH);
  const modelsDirAbs = resolveModelsDir(config.basePath, config.localModels.modelsDir);

  if (sub === "list") {
    const reg = loadRegistry(modelsDirAbs);
    if (reg.models.length === 0) {
      console.log("[models] none registered — run `mantle pull <hf-link>`");
      return;
    }
    console.log(`[models] ${reg.models.length} model(s) in ${modelsDirAbs}\n`);
    for (const m of reg.models) {
      const marker = reg.defaultModelId === m.id ? "*" : " ";
      const present = existsSync(resolveModelFile(modelsDirAbs, m));
      console.log(` ${marker} ${m.id}${present ? "" : "   ⚠ FILE MISSING"}`);
      const bits = [
        m.file,
        m.sizeBytes ? fmtBytes(m.sizeBytes) : null,
        m.quant ?? null,
        m.reasoning ? "reasoning" : null,
        m.source ?? null,
      ].filter(Boolean);
      console.log(`     ${bits.join("  ·  ")}`);
    }
    console.log(`\n  (* = default)`);
    return;
  }

  if (sub === "rm" || sub === "remove") {
    const id = args[1];
    const delFile = args.includes("--file");
    if (!id) {
      console.error("Usage: mantle models rm <id> [--file]");
      process.exit(1);
    }
    const reg = loadRegistry(modelsDirAbs);
    const entry = reg.models.find((m) => m.id === id);
    if (!entry) {
      console.error(`[models] not found: ${id}`);
      process.exit(1);
    }
    const removed = removeModel(modelsDirAbs, id);
    let fileMsg = "";
    if (delFile && removed) {
      try {
        const f = resolveModelFile(modelsDirAbs, removed);
        if (existsSync(f)) {
          unlinkSync(f);
          fileMsg = ` + deleted ${basename(f)}`;
        }
      } catch (err) {
        fileMsg = ` (file delete failed: ${err instanceof Error ? err.message : err})`;
      }
    }
    console.log(`[models] removed "${id}"${fileMsg}`);
    console.log(`         (if mantle is running with this model loaded, restart or unload to free it)`);
    return;
  }

  if (sub === "set") {
    const id = args[1];
    if (!id || id.startsWith("--")) {
      console.error(
        "Usage: mantle models set <id> [--tools off|core|all] [--reasoning on|off]\n" +
          "         [--temp F] [--top-p F] [--top-k N] [--min-p F] [--repeat-penalty F] [--max-tokens N]\n" +
          "         [--ctx N] [--ngl N] [--threads N] [--kv-cache f16|q8_0|q4_0] [--flash-attn auto|on|off] [--default]",
      );
      process.exit(1);
    }
    if (!loadRegistry(modelsDirAbs).models.find((m) => m.id === id)) {
      console.error(`[models] not found: ${id}`);
      process.exit(1);
    }
    const patch: Record<string, unknown> = {};
    const num = (v: string | undefined) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    for (let i = 2; i < args.length; i++) {
      const a = args[i];
      if (a === "--tools") {
        const v = (args[++i] ?? "").toLowerCase();
        if (v === "off" || v === "core" || v === "all") patch.toolMode = v;
        else if (v === "on") patch.toolMode = "core";
        else {
          console.error("[models] --tools expects: off | core | all");
          process.exit(1);
        }
      } else if (a === "--reasoning") patch.reasoning = parseOnOff(args[++i]);
      else if (a === "--ctx" || a === "--ctx-size") patch.ctxSize = num(args[++i]);
      else if (a === "--ngl" || a === "--gpu-layers") patch.gpuLayers = num(args[++i]);
      else if (a === "--threads") patch.threads = num(args[++i]);
      else if (a === "--kv-cache" || a === "--kv") {
        const v = (args[++i] ?? "").toLowerCase();
        if (v === "f16" || v === "q8_0" || v === "q4_0") patch.kvCacheType = v;
        else {
          console.error("[models] --kv-cache expects: f16 | q8_0 | q4_0");
          process.exit(1);
        }
      } else if (a === "--flash-attn" || a === "--fa") {
        const v = (args[++i] ?? "").toLowerCase();
        if (v === "auto" || v === "on" || v === "off") patch.flashAttn = v;
        else {
          console.error("[models] --flash-attn expects: auto | on | off");
          process.exit(1);
        }
      } else if (a === "--temp" || a === "--temperature") patch.temperature = num(args[++i]);
      else if (a === "--top-p") patch.topP = num(args[++i]);
      else if (a === "--top-k") patch.topK = num(args[++i]);
      else if (a === "--min-p") patch.minP = num(args[++i]);
      else if (a === "--repeat-penalty") patch.repeatPenalty = num(args[++i]);
      else if (a === "--max-tokens") patch.maxTokens = num(args[++i]);
      else if (a === "--default") patch.makeDefault = true;
      else {
        console.error(`[models] unknown flag: ${a}`);
        process.exit(1);
      }
    }
    if (Object.keys(patch).length === 0) {
      console.error("[models] nothing to set — pass at least one of --tools/--reasoning/--ctx/--ngl/--threads/--default");
      process.exit(1);
    }
    updateModel(modelsDirAbs, id, patch);
    console.log(`[models] updated "${id}": ${JSON.stringify(patch)}`);
    console.log(`         (spawn-setting changes — ctx/ngl/threads — take effect on next load; reload or restart to apply)`);
    return;
  }

  console.error(`[models] unknown subcommand: ${sub}. Use: list | rm <id> [--file] | set <id> [flags]`);
  process.exit(1);
}
