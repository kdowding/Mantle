/**
 * Inbound user authentication — the credential store for logging INTO mantle.
 *
 * Distinct from the *outbound* provider auth in this directory
 * (openai-codex.ts / grok-build.ts), which authenticates mantle TO a model
 * provider. This file is about gating the app itself.
 *
 * Scope today: a single account (one username + password). The store is a
 * `users[]` array rather than a single record on purpose — when multi-user
 * lands (per-user workspaces + tool sandboxing — see the auth design notes),
 * the persistence shape and the `username` carried in the session token are
 * already in place, so it won't be a rewrite. The setup flow refuses to
 * create a second user for now.
 *
 * Passwords are hashed with Bun.password (argon2id). Lost-password recovery:
 * delete .mantle/auth/users.json to drop back to the first-run setup screen.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { resolve } from "path";
import { rotateSessionSecret } from "./session-token.js";
import { ensureSecureDir } from "./secure-dir.js";

export interface StoredUser {
  username: string;
  passwordHash: string;
  createdAt: number;
}

interface CredentialStore {
  users: StoredUser[];
}

const MIN_PASSWORD_LENGTH = 8;

function authDir(basePath: string): string {
  return resolve(basePath, ".mantle", "auth");
}

function usersPath(basePath: string): string {
  return resolve(authDir(basePath), "users.json");
}

// Read the store, distinguishing "absent" (→ no users, first-run OK) from
// "present but unparseable" (→ "corrupt"). The setup-gating callers must treat
// corrupt as fail-closed so a truncated/tampered file can't drop the app back
// to the public, unauthenticated account-creation screen.
type UsersRead = { users: StoredUser[] } | "corrupt";
function readUsersResult(basePath: string): UsersRead {
  const p = usersPath(basePath);
  if (!existsSync(p)) return { users: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as CredentialStore;
    return { users: Array.isArray(raw.users) ? raw.users : [] };
  } catch {
    return "corrupt";
  }
}

export function loadUsers(basePath: string): StoredUser[] {
  const r = readUsersResult(basePath);
  // Corrupt → [] for verify/changePassword/CLI: they fail safe on their own
  // (can't verify against an unreadable store → login is simply refused).
  return r === "corrupt" ? [] : r.users;
}

export function hasAnyUser(basePath: string): boolean {
  const r = readUsersResult(basePath);
  // Fail closed: a corrupt store counts as "an account exists" so it cannot
  // reopen the first-run setup screen.
  return r === "corrupt" ? true : r.users.length > 0;
}

function saveUsers(basePath: string, users: StoredUser[]): void {
  ensureSecureDir(authDir(basePath));
  // Atomic write: a crash mid-write must not leave a truncated users.json —
  // the fail-closed read would treat that as "corrupt" and lock the owner out.
  // Write a temp file, then rename (atomic replace on POSIX + Windows).
  const target = usersPath(basePath);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify({ users }, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, target);
}

export interface CreateUserResult {
  ok: boolean;
  error?: string;
}

/**
 * Create the (single) account. Refuses if a user already exists — second
 * accounts wait on real multi-user isolation. Validates username + password
 * length; hashes with argon2id.
 */
export async function createUser(
  basePath: string,
  username: string,
  password: string,
): Promise<CreateUserResult> {
  const name = username.trim();
  if (!name) return { ok: false, error: "Username is required." };
  if (name.length > 64) return { ok: false, error: "Username must be 64 characters or fewer." };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }

  const existing = readUsersResult(basePath);
  if (existing === "corrupt") {
    return {
      ok: false,
      error: "users.json is present but unreadable — refusing to overwrite it. Inspect it, or run `mantle user reset`.",
    };
  }
  if (existing.users.length > 0) {
    return { ok: false, error: "An account already exists. Multi-user is not supported yet." };
  }

  const passwordHash = await Bun.password.hash(password); // argon2id (Bun default)
  ensureSecureDir(authDir(basePath));
  const store: CredentialStore = { users: [{ username: name, passwordHash, createdAt: Date.now() }] };
  try {
    // Exclusive create (wx): if two first-run setups race, the second write
    // fails here instead of silently clobbering the first account (TOCTOU).
    writeFileSync(usersPath(basePath), JSON.stringify(store, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
  } catch {
    return { ok: false, error: "An account already exists." };
  }
  return { ok: true };
}

// Decoy hash for the absent-user path, computed lazily on the first miss
// (an eager module-load hash would tax every CLI startup with an argon2id).
let decoyHashPromise: Promise<string> | null = null;
function getDecoyHash(): Promise<string> {
  decoyHashPromise ??= Bun.password.hash("mantle-decoy-password-never-matches");
  return decoyHashPromise;
}

/**
 * Verify a username/password pair. Case-insensitive username match.
 * Returns false (never throws) on any miss or malformed hash.
 *
 * An unknown username still runs a full argon2id verify against a decoy
 * hash, so response timing doesn't reveal whether the account name exists
 * (with one account total this leaks little, but it's cheap to close).
 */
export async function verifyUser(
  basePath: string,
  username: string,
  password: string,
): Promise<boolean> {
  const name = username.trim().toLowerCase();
  const user = loadUsers(basePath).find((u) => u.username.toLowerCase() === name);
  try {
    if (!user) {
      await Bun.password.verify(password, await getDecoyHash());
      return false;
    }
    return await Bun.password.verify(password, user.passwordHash);
  } catch {
    return false;
  }
}

/**
 * Change an existing account's password. Used by future CLI/settings flows;
 * exported now so the store stays the single source of truth for hashing.
 */
export async function changePassword(
  basePath: string,
  username: string,
  newPassword: string,
): Promise<CreateUserResult> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  const name = username.trim().toLowerCase();
  const users = loadUsers(basePath);
  const user = users.find((u) => u.username.toLowerCase() === name);
  if (!user) return { ok: false, error: "User not found." };
  user.passwordHash = await Bun.password.hash(newPassword);
  saveUsers(basePath, users);
  // A password change should not leave old sessions valid — rotate the signing
  // secret so existing cookies are invalidated (on the next server start; a
  // running server holds the key in memory).
  rotateSessionSecret(basePath);
  return { ok: true };
}
