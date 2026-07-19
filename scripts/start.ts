// One-command foreground start for rev://MANTLE. Builds the UI if it's stale,
// boots the server in THIS process (logs print here; Ctrl+C stops it cleanly —
// index.ts owns the graceful-shutdown handlers), and opens the browser once the
// server answers. The friendly day-to-day entry; `start.cmd` / `start.sh` wrap
// this. For a detached background service instead, use `mantle start`.

import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { ensureUiBuilt } from "../src/ui-build.js";

const ROOT = resolve(import.meta.dir, "..");
const url = resolveLocalUrl(ROOT);

// 1) Rebuild the UI if its source moved since the last build. Non-fatal: if the
//    build errors, warn and carry on — the previous dist (if any) still serves,
//    and the backend is useful regardless.
try {
  await ensureUiBuilt(ROOT);
} catch (err) {
  console.error(
    `[MANTLE] UI build failed — continuing with the existing build if present.\n  ${err instanceof Error ? err.message : err}`,
  );
}

// 2) If a server is already up (e.g. a background `mantle start`), don't try to
//    boot a second one onto the same port — just open the browser. A rebuild
//    from step 1 is picked up on refresh (dist is served per request), no
//    restart needed.
if (await isUp(url)) {
  console.log(`[MANTLE] Already running at ${url} — opening the browser.`);
  await openBrowser(url);
  process.exit(0);
}

// 3) Boot the server in-process. index.ts's top-level runs to completion once
//    Bun.serve is listening; the import resolves there and the process stays
//    alive on the server's event loop.
console.log("[MANTLE] Starting server (Ctrl+C to stop)...");
await import("../src/index.js");

// 4) Open the browser as soon as the server answers its public health route.
await openWhenReady(url);

// ── helpers ─────────────────────────────────────────────────────────────────

// Loopback URL the browser should open. Reads .mantle/config.json directly (no
// loadConfig side effects) for a custom port / TLS; always targets localhost
// since config.server.host may be 0.0.0.0. Defaults to http://localhost:3333.
function resolveLocalUrl(root: string): string {
  let port = 3333;
  let tls = false;
  try {
    const cfgPath = resolve(root, ".mantle", "config.json");
    if (existsSync(cfgPath)) {
      const raw = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
        server?: { port?: unknown; tls?: unknown };
      };
      if (typeof raw.server?.port === "number" && raw.server.port > 0) port = raw.server.port;
      tls = Boolean(raw.server?.tls); // match server/index.ts truthiness
    }
  } catch {
    // Unreadable/absent config (fresh clone) → defaults.
  }
  return `${tls ? "https" : "http"}://localhost:${port}`;
}

// Is a server answering on `url`? Probes the PUBLIC auth-session route (200s
// without a cookie). Under TLS this relies on the cert being trusted — the
// recommended local setups (mkcert, `tailscale cert`) install a trusted cert,
// so a verified probe succeeds. A raw untrusted self-signed cert would fail the
// probe; the only cost is missing the "already running" shortcut and surfacing
// a port-in-use error instead, so verification stays on (secure by default).
async function isUp(url: string): Promise<boolean> {
  try {
    const resp = await fetch(`${url}/api/auth/session`);
    return resp.ok;
  } catch {
    return false;
  }
}

async function openWhenReady(url: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (await isUp(url)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  await openBrowser(url);
}

// Launch the OS default browser at `url`. Best-effort — if it fails, we print
// the URL so the user can open it themselves.
async function openBrowser(url: string): Promise<void> {
  try {
    const cmd =
      process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : process.platform === "darwin"
          ? ["open", url]
          : ["xdg-open", url];
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    console.log(`[MANTLE] Opened ${url} in your browser.`);
  } catch {
    console.log(`[MANTLE] Open ${url} in your browser.`);
  }
}
