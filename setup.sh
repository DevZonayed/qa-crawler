#!/usr/bin/env sh
# One-time setup for a fresh clone: install deps (compiles better-sqlite3, downloads Chromium) and build.
# A plain script, NOT a package.json script — pnpm refuses to `run` scripts before node_modules exists,
# so the bootstrap must live outside pnpm's script runner.
set -e
cd "$(dirname "$0")"
echo "▶ qa-crawler setup: installing dependencies (native SQLite + Chromium)…"
pnpm install
echo "▶ building…"
pnpm build
echo "✔ setup complete. Smoke test:  node dist/cli.js --url https://example.com"
