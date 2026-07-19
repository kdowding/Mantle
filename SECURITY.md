# Security Policy

Mantle is an early (0.1.x) personal-AI agent harness. Security fixes land on the
default branch; there are no long-term support branches yet.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Use GitHub's
private vulnerability reporting on this repository:

- Go to the **Security** tab → **Report a vulnerability** (GitHub Security
  Advisories), or
- if that isn't available to you, open a minimal public issue asking for a
  private contact channel — without the details.

Include what you'd expect: affected version/commit, a description, reproduction
steps, and impact. We'll acknowledge, investigate, and coordinate a fix and
disclosure timeline with you.

## Threat model (what to keep in mind)

Mantle is **single-user and local-first**. The design assumes one trusted
operator on their own machine. Concretely:

- **The login wall is the primary control.** It's on by default; the server
  binds to `127.0.0.1` by default. Binding to a non-loopback host
  (`server.host`) exposes the app to the network — only do that deliberately,
  keep auth on, and configure TLS (`server.tls`), or the session cookie is
  sniffable over plain HTTP. First-run account setup is restricted to loopback
  clients (override: `MANTLE_ALLOW_REMOTE_SETUP=1`).
- **The `bash` tool is a full shell, by design.** An agent (or a prompt
  injection it follows) can run anything the Mantle process can. The filesystem
  tool boundary, the SSRF guard, and the untrusted-content framing are
  **defense-in-depth against prompt injection for the tool surface** — they are
  not a sandbox. Do not expose Mantle to untrusted users.
- **Autonomous (cron) runs are contained.** Scheduled runs use a least-privilege
  tool preset (read-only by default), a per-job egress domain allow-list for the
  net-guarded fetch tools, and a default-deny on write/exfil integration tools
  (override: `MANTLE_ALLOW_AUTONOMOUS_WRITES=1`). `MANTLE_CRON_NO_BASH=1` bans
  bash in scheduled runs entirely.
- **Third-party integrations** (GitHub, Gmail) request read-only scope by
  default; write/exfil tools require explicit per-(agent, integration) write
  scope and are hidden + execution-gated otherwise.

## Secrets — the storage contract

Where each class of secret lives, and what protects it at rest:

| Secret | Where it lives |
|---|---|
| Provider API keys (Anthropic / OpenAI / xAI / kie.ai) | `.mantle/config.json` |
| Subscription OAuth tokens (ChatGPT Codex, Grok Build) | `.mantle/auth/*.json` |
| Integration tokens (GitHub, Gmail) | `.mantle/auth/integrations/` |
| Login password hash (argon2id) + cookie-signing secret | `.mantle/auth/` |
| Env-var keys (`ANTHROPIC_API_KEY`, …) | your shell, or a gitignored `.env` (Bun auto-loads it) |

Protections, in code rather than convention:

- Everything under `.mantle/` is gitignored; secret files are written
  atomically with mode `0600`.
- POSIX mode bits are a **no-op on Windows**, so at boot Mantle strips ACL
  inheritance on `.mantle/` (and re-asserts it on `.mantle/auth` at every
  write) via `icacls`, granting only the current user — `src/auth/secure-dir.ts`.
- Keys are **write-only through the API**: the UI is told a key's *presence
  and source*, never its value. Config-file keys win over env vars; env vars
  only fill providers you haven't set.
- The agent tool surface always denies `.mantle/auth` and `config.json`
  (`fs-boundary`), regardless of `allowedRoots`.

What stays on the operator: full-disk encryption (theft-of-device is out of
Mantle's reach), not committing `.env`, and treating backups of `.mantle/` as
secret-bearing.

If you find a secret committed to history, please report it privately as above.
