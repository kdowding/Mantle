#!/usr/bin/env bash
# --- Boot rev://MANTLE (foreground) ------------------------------------------
# Builds the UI if it's stale, starts the server here (logs print in this
# terminal, Ctrl+C stops it cleanly), then opens the browser. For a detached
# background service instead, use:  mantle start
cd "$(dirname "$0")" || exit 1
command -v bun >/dev/null 2>&1 || { echo "Bun isn't installed. Get it from https://bun.sh, then run ./setup.sh."; exit 1; }
exec bun run scripts/start.ts
