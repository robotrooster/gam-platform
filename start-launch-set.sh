#!/bin/bash
# S535: launch-set auto-starter. Runs at login via launchd
# (~/Library/LaunchAgents/com.gam.launchset.plist) so a reboot brings
# the platform up without anyone typing commands. Starts ONLY the
# launch set (memory: gam-launch-portal-scope): shared watch, API,
# landlord, tenant, admin, marketing, POS, admin-ops. The other 8
# portals stay down. Marketing (:3004) is NOT started here — it is the
# LIVE public site (apex goldassetmanagement.com via the Cloudflare
# tunnel), a production launchd service (com.gam.marketing, KeepAlive)
# serving apps/marketing/server.js. Never kill :3004 from dev tooling.
# Idempotent — safe to re-run by hand any time:
#   bash ~/gam/start-launch-set.sh
# Logs land in the usual /tmp/gam-<app>.log files; this script's own
# log is /tmp/gam-launchset-startup.log.

export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")"

echo "═══ GAM launch-set start $(date) ═══"

# Postgres is its own launchd service (homebrew.mxcl.postgresql@16) but
# boot ordering isn't guaranteed — wait up to 60s for it.
for i in $(seq 1 30); do
  pg_isready -h localhost -p 5432 >/dev/null 2>&1 && break
  echo "waiting for postgres ($i)..."; sleep 2
done
if ! pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
  echo "✗ postgres never came up — aborting app start"; exit 1
fi

# Same cleanup discipline as dev.sh (S415): kill zombie ts-node-dev
# parents and anything squatting on launch-set ports.
pkill -f "ts-node-dev" 2>/dev/null || true
pkill -f "tsc.*-b.*--watch" 2>/dev/null || true
sleep 1
# S550: :4000 is NOT in this list — the API is a production launchd
# service (com.gam.api, KeepAlive); killing it here would just fight
# launchd. Ports below are the local dev portal servers only.
for port in 3001 3002 3003 3005 3009; do
  pid=$(lsof -ti tcp:$port 2>/dev/null) || true
  [ -n "$pid" ] && kill -9 $pid 2>/dev/null && echo "  killed :$port (pid $pid)" || true
done
sleep 1

echo "Running database migrations..."
if ! npm run db:migrate; then
  echo "✗ Migrations failed. Apps will not start."; exit 1
fi

echo "Starting launch set..."
nohup npm run build:watch --workspace=packages/shared > /tmp/gam-shared.log 2>&1 &
sleep 5   # let shared do its first compile so api boots against fresh dist
# S550: API runs as com.gam.api (production, compiled). Ensure it's up.
launchctl kickstart gui/$(id -u)/com.gam.api 2>/dev/null || true
sleep 2
nohup npm run dev --workspace=apps/landlord  > /tmp/gam-landlord.log  2>&1 &
nohup npm run dev --workspace=apps/tenant    > /tmp/gam-tenant.log    2>&1 &
nohup npm run dev --workspace=apps/admin     > /tmp/gam-admin.log     2>&1 &
nohup npm run dev --workspace=apps/pos       > /tmp/gam-pos.log       2>&1 &
nohup npm run dev --workspace=apps/admin-ops > /tmp/gam-admin-ops.log 2>&1 &
sleep 10

# Make sure the production marketing service is up (it should be via
# its own KeepAlive, but a kickstart is harmless and self-heals).
launchctl kickstart gui/$(id -u)/com.gam.marketing 2>/dev/null || true

echo "Listening ports:"
lsof -nP -i tcp:3001,3002,3003,3004,3005,3009,4000 2>/dev/null | grep LISTEN | awk '{print "  " $9}' | sort -u
echo "═══ done $(date) ═══"
