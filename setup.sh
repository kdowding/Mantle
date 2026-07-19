#!/usr/bin/env bash
# --- First-time setup for rev://MANTLE ---------------------------------------
# Installs dependencies and builds the UI. Run once after cloning, and again
# after pulling UI changes. Then run ./start.sh.
set -e
cd "$(dirname "$0")"
command -v bun >/dev/null 2>&1 || { echo "Bun isn't installed. Get it from https://bun.sh, then re-run."; exit 1; }
echo "Installing dependencies..."
bun install
echo "Building the UI..."
bun run ui:build
echo
echo "Setup complete. Run ./start.sh, then open http://localhost:3333"
echo "(Optional extras -- voice/memory sidecars and local models -- are covered in the README.)"
