#!/usr/bin/env bash
# Rebuild + restart the launchd-managed API (S594).
#
# The API on :4000 is the BUILT dist under launchd `com.gam.api`
# (apps/api/dist/index.js) — NOT ts-node-dev. So a backend/source change is NOT
# live until the dist is rebuilt and the service kickstarted. (Frontend vite dev
# servers HMR on their own; this script is only for API/backend changes.)
#
#   Usage: bash scripts/restart-api.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "[restart-api] building apps/api (tsc -b)…"
( cd "$ROOT/apps/api" && npm run build )

echo "[restart-api] kickstarting com.gam.api…"
launchctl kickstart -k "gui/$(id -u)/com.gam.api"
sleep 2

code="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:4000/health || true)"
echo "[restart-api] /health -> ${code}"
if [ "$code" = "200" ]; then
  echo "[restart-api] API up."
else
  echo "[restart-api] WARN: API not healthy. Inspect: launchctl print gui/$(id -u)/com.gam.api"
  echo "[restart-api] An orphan bound to :4000 causes EADDRINUSE — check: lsof -ti tcp:4000"
  exit 1
fi
