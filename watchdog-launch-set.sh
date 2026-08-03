#!/bin/bash
# S536: launch-set watchdog. Runs every 5 minutes via launchd
# (~/Library/LaunchAgents/com.gam.watchdog.plist) and restarts any
# launch-set dev server that died between logins — closes the gap
# where com.gam.launchset only fires at login, so a mid-session death
# (crash, OOM, accidental kill) meant downtime until reboot.
# Marketing (:3004) is a KeepAlive launchd service and the tunnel
# self-heals — neither is managed here. Preview duplicates run on
# 31xx ports and are ignored entirely.

export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")"

# If postgres is down there is nothing useful to revive — the login
# launchset (next boot) handles cold starts.
pg_isready -h localhost -p 5432 >/dev/null 2>&1 || exit 0

up()   { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
boot() { # $1=port  $2=workspace  $3=logname
  if ! up "$1"; then
    echo "[watchdog] $(date '+%F %T') reviving $2 (:$1)"
    nohup npm run dev --workspace="$2" > "/tmp/gam-$3.log" 2>&1 &
  fi
}

# Shared watcher first (no port — API compiles against its dist).
if ! pgrep -f "tsc.*-b.*--watch" >/dev/null 2>&1; then
  echo "[watchdog] $(date '+%F %T') reviving shared watcher"
  nohup npm run build:watch --workspace=packages/shared > /tmp/gam-shared.log 2>&1 &
  sleep 4
fi

if ! up 4000; then
  echo "[watchdog] $(date '+%F %T') reviving API (:4000)"
  nohup npm run dev --workspace=apps/api > /tmp/gam-api.log 2>&1 &
  sleep 6
fi

boot 3001 apps/landlord  landlord
boot 3002 apps/tenant    tenant
boot 3003 apps/admin     admin
boot 3005 apps/pos       pos
boot 3006 apps/books     books
boot 3009 apps/admin-ops admin-ops
exit 0
