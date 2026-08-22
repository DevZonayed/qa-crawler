#!/usr/bin/env sh
# One-time setup for a fresh clone: install deps (compiles better-sqlite3, downloads Chromium) and build.
# A plain script, NOT a package.json script — pnpm refuses to `run` scripts before node_modules exists,
# so the bootstrap must live outside pnpm's script runner. Dependency build scripts are allow-listed via
# pnpm.onlyBuiltDependencies in package.json (pnpm 10+ blocks them by default).
set -e
cd "$(dirname "$0")"

echo "▶ qa-crawler setup: installing dependencies (native SQLite + Chromium)…"
# Non-fatal: some pnpm versions exit non-zero over blocked build scripts even when the install itself
# landed; the verification steps below compile/download whatever is missing either way.
pnpm install || echo "  (pnpm install exited non-zero — verifying and repairing below)"

echo "▶ building…"
pnpm build

echo "▶ verifying the native SQLite module…"
if ! node -e "require('better-sqlite3')" 2>/dev/null; then
  echo "  better-sqlite3 binary missing — compiling from source…"
  # pnpm rebuild respects the same build-script block, so compile directly in the package dir.
  SQLITE_DIR=$(find node_modules/.pnpm -maxdepth 3 -type d -path "*better-sqlite3@*/node_modules/better-sqlite3" | head -1)
  ( cd "$SQLITE_DIR" && npm run build-release )
  node -e "require('better-sqlite3')"
fi

echo "▶ verifying Chromium…"
npx playwright install chromium >/dev/null

echo "▶ verifying the engine loads…"
node -e "import('./dist/ledger.js').then(m => { const l = new m.Ledger('/tmp/qa-crawler-setup-check','check'); l.close(); console.log('  engine OK'); })"

echo "✔ setup complete. Smoke test:  node dist/cli.js --url https://example.com"
