#!/bin/bash
set -e

echo "Killing existing processes on all GAM ports..."
for port in 3001 3002 3003 3004 3005 3006 3007 3008 3009 3011 4000 4001; do
  pid=$(lsof -ti tcp:$port 2>/dev/null)
  [ -n "$pid" ] && kill -9 $pid 2>/dev/null && echo "  Killed :$port (pid $pid)"
done
sleep 2

# Kill any leftover shared watcher (tsc -b --watch from a prior run)
pkill -f "tsc.*-b.*--watch" 2>/dev/null && echo "  Killed prior shared watcher" || true

# S415: kill orphan ts-node-dev parents. The port-kill loop above only
# kills the child node process listening on the port; the ts-node-dev
# PARENT (`--respawn` mode) survives and immediately respawns a new
# child. Over time (laptop sleep, terminal close, session reset)
# these accumulate into zombies that starve CPU and hold DB
# connections — found 9 of them in S414, each at 60-90% CPU, eating
# 25,000+ minutes of cumulative CPU time. The full test suite was
# running at 1300s instead of its true 65s baseline.
pkill -f "ts-node-dev" 2>/dev/null && echo "  Killed orphan ts-node-dev parents" || true
sleep 1

cd "$(dirname "$0")"

# ── Database migrations ────────────────────────────────────────
# Run synchronously before booting any app. Failure aborts startup.
echo ""
echo "Running database migrations..."
if ! npm run db:migrate; then
  echo ""
  echo "✗ Migrations failed. Apps will not start."
  echo "  See output above for the failing migration."
  exit 1
fi
echo "✓ Migrations up to date."
echo ""

echo "Starting servers..."
nohup npm run build:watch --workspace=packages/shared > /tmp/gam-shared.log 2>&1 & echo "  Shared    → tsc --watch"
sleep 2  # let shared do its first compile so api boots against fresh dist
nohup npm run dev --workspace=apps/api        > /tmp/gam-api.log        2>&1 & echo "  API       → :4000"
sleep 3
nohup npm run dev --workspace=apps/landlord   > /tmp/gam-landlord.log   2>&1 & echo "  Landlord  → :3001"
nohup npm run dev --workspace=apps/tenant     > /tmp/gam-tenant.log     2>&1 & echo "  Tenant    → :3002"
nohup npm run dev --workspace=apps/admin      > /tmp/gam-admin.log      2>&1 & echo "  Admin     → :3003"
nohup npm run dev --workspace=apps/marketing  > /tmp/gam-marketing.log  2>&1 & echo "  Marketing → :3004"
nohup npm run dev --workspace=apps/pos        > /tmp/gam-pos.log        2>&1 & echo "  POS       → :3005"
nohup npm run dev --workspace=apps/books      > /tmp/gam-books.log      2>&1 & echo "  Books     → :3006"
nohup npm run dev --workspace=apps/listings   > /tmp/gam-listings.log   2>&1 & echo "  Listings  → :3008"
nohup npm run dev --workspace=apps/admin-ops  > /tmp/gam-admin-ops.log  2>&1 & echo "  AdminOps  → :3009"
nohup npm run dev --workspace=apps/pm-company > /tmp/gam-pm-company.log 2>&1 & echo "  PM Portal → :3011"
sleep 4

echo ""
echo "═══════════════════════════════════"
echo "  GAM Platform — Port Map"
echo "═══════════════════════════════════"
echo "  Shared    tsc -b --watch (no port, logs in /tmp/gam-shared.log)"
echo "  API       http://localhost:4000"
echo "  Landlord  http://localhost:3001"
echo "  Tenant    http://localhost:3002"
echo "  Admin     http://localhost:3003"
echo "  Marketing http://localhost:3004"
echo "  POS       http://localhost:3005"
echo "  Books     http://localhost:3006"
echo "  Listings  http://localhost:3008"
echo "  AdminOps  http://localhost:3009"
echo "  PM Portal http://localhost:3011"
echo "═══════════════════════════════════"

# Verify all ports are actually listening
echo ""
echo "Listening ports:"
lsof -i tcp:3001,3002,3003,3004,3005,3006,3008,3009,3011,4000 2>/dev/null | grep LISTEN | awk '{print "  " $9}' | sort
