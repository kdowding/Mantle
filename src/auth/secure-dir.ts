/**
 * Shared creation + at-rest hardening for secret-holding runtime dirs:
 * `.mantle/` itself (config.json provider keys, session transcripts, cron
 * DB, uploads — boot asserts it) and `.mantle/auth` (the cookie-signing
 * secret, users.json, subscription + integration tokens — each store
 * asserts it on write, so the tighter dir also self-heals server-down).
 *
 * On POSIX `mode: 0o700/0o600` does the job. On Windows those mode bits are
 * a NO-OP — Bun/Node silently ignore them — so a default-ACL profile dir
 * leaves the secret readable by anything that can read the user's files
 * (and on shared/admin-managed machines, by other principals entirely).
 * Here we explicitly cut ACL inheritance and grant only the current user
 * full control via `icacls`, the supported way to express "0700" on NTFS.
 *
 * Best-effort by design: a failed ACL tighten logs a warning but never
 * blocks boot — locking the owner out of their own auth store would be a
 * worse failure than a weaker at-rest posture. Re-asserted once per process
 * per directory (boot calls this even when the dir already exists, so
 * installs created before this fix get tightened too).
 */

import { existsSync, mkdirSync } from "fs";

const secured = new Set<string>();

export function ensureSecureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" || secured.has(dir)) return;
  secured.add(dir); // one attempt (and at most one warning) per process
  try {
    // Domain-qualified current user. `whoami` handles domain accounts and
    // renamed users better than env vars; fall back to USERDOMAIN\USERNAME.
    let user = "";
    const who = Bun.spawnSync(["whoami"]);
    if (who.success) user = who.stdout.toString().trim();
    if (!user && process.env.USERNAME) {
      user = process.env.USERDOMAIN
        ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
        : process.env.USERNAME;
    }
    if (!user) {
      console.warn(`[MANTLE:auth] could not resolve current user — ${dir} keeps inherited ACLs`);
      return;
    }
    // /inheritance:r — strip inherited ACEs; /grant:r — replace with exactly
    // one ACE: this user, full control, inherited by files + subdirs.
    const res = Bun.spawnSync([
      "icacls", dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`,
    ]);
    if (!res.success) {
      const detail = res.stderr.toString().trim() || res.stdout.toString().trim();
      console.warn(`[MANTLE:auth] could not restrict ACL on ${dir}: ${detail}`);
    }
  } catch (err) {
    console.warn(
      `[MANTLE:auth] ACL hardening for ${dir} failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}
