#!/usr/bin/env sh
# One-time setup for a fresh clone: install deps (compiles better-sqlite3, downloads Chromium) and build.
# A plain script, NOT a package.json script — pnpm refuses to `run` scripts before node_modules exists,
# so the bootstrap must live outside pnpm's script runner. Dependency build scripts are allow-listed via
# pnpm.onlyBuiltDependencies in package.json (pnpm 10+ blocks them by default).
set -e
cd "$(dirname "$0")"

echo "▶ qa-crawler setup: installing dependencies (native SQLite + Chromium)…"
pnpm install

echo "▶ building…"
pnpm build

echo "▶ verifying the native SQLite module…"
if ! node -e "require('better-sqlite3')" 2>/dev/null; then
  echo "  better-sqlite3 binary missing — rebuilding from source…"
  pnpm rebuild better-sqlite3
  node -e "require('better-sqlite3')"
fi

echo "▶ verifying Chromium…"
npx playwright install chromium >/dev/null

echo "▶ verifying the engine loads…"
node -e "import('./dist/ledger.js').then(m => { const l = new m.Ledger('/tmp/qa-crawler-setup-check','check'); l.close(); console.log('  engine OK'); })"

echo "✔ setup complete. Smoke test:  node dist/cli.js --url https://example.com"
