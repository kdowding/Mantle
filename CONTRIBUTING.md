# Contributing to Mantle

Thanks for your interest. Mantle is an early personal project: bug reports are
always welcome, and PRs are read and considered — but this is a
strongly-opinionated codebase with a single maintainer, so a PR may be declined
for vision fit rather than quality. **Open an issue before investing real
effort in a feature PR** so we can talk it through first. Small fixes
(bugs, typos, platform issues) can skip straight to a PR.

## Prerequisites

- [**Bun**](https://bun.sh) 1.1+ (runtime, package manager, test runner).
- Optional extras (Englyph memory, voice, local models) are not needed to build
  or test the core — see the README.

## Setup

```bash
bun install
bun run ui:build   # build the Svelte UI (served by the Bun server)
```

Run the app in the foreground with `./start.sh` (or `start.cmd` on Windows), or
`bun run dev` for the backend alone. For UI iteration, `bun run ui:dev` (Vite on
:5174, proxying the API to :3333).

## Before you open a PR

Please make sure all of these pass — CI runs the same set:

```bash
bun run typecheck     # tsc --noEmit
bun run lint          # oxlint
bun run check:arch    # module-direction + import-cycle rules
bun test src          # unit tests
bun run ui:build      # the UI compiles
bun run check:svelte  # svelte-check (0 errors / 0 warnings)
```

Add or update tests for behavior you change — security-relevant code especially.

## Architecture rules (enforced by `check:arch`)

Mantle is layered: a light **core** (`src/agent`, `src/tools`, `src/config`,
`src/cron`, `src/auth`, …) with **bolt-on** features in `src/rooms/*` and
`src/integrations/*`.

- `rooms/` and `integrations/` MAY import core, but **never `src/server`**.
- **Core never imports `rooms/` or `integrations/`.** Capabilities are injected
  at the composition root (`src/index.ts`) and the server layer.

If `check:arch` fails, you've crossed a layer — inject the dependency instead.

## Conventions

- **UI is Svelte 5 runes only** — no Svelte 4 patterns (`export let`, `$:`,
  `on:click`, stores for app state). See `ui/CLAUDE.md`.
- **No secrets in the repo.** Keys live in `.mantle/` / `.env` (both gitignored).
  Never commit credentials, tokens, or personal data; never echo secrets to the
  client or logs.
- Keep new code in the style of the surrounding code (naming, comments, idioms).
- Write clear commit messages describing the "why".

## Reporting security issues

Do **not** file them as public issues — see [SECURITY.md](SECURITY.md).
