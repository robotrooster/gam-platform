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

# ── POSTGRES: RECOVER IT, DO NOT SHRUG AT IT ────────────────────────────────
#
# S624. This used to read:
#
#   pg_isready ... || exit 0     # "nothing useful to revive"
#
# It exited SILENTLY in the one situation that matters most. On 2026-08-26 the
# host took a kernel panic; Postgres then refused to start because the unclean
# shutdown left a stale postmaster.pid, and after the reboot that PID had been
# recycled to a macOS speech service. Brew's launchd job retried every ten
# seconds and logged the same FATAL for eleven minutes. The watchdog ran, saw
# the database down, and quit.
#
# Worse, nothing looked wrong from outside: the API stayed up and answered
# /health with a 200 while every query beneath it failed. A health check that
# does not touch the database is a health check that lies.
#
# So: try to bring it back, and only then get out of the way.
if ! pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
  echo "[watchdog] $(date '+%F %T') POSTGRES IS DOWN"
  PGDATA=/opt/homebrew/var/postgresql@16
  PIDFILE="$PGDATA/postmaster.pid"

  # A stale pid file is the ONLY thing this is allowed to clear, and only after
  # proving no postmaster holds the directory. Deleting it while a real
  # postmaster is running invites two postmasters on one data directory, which
  # is how a database gets corrupted — far worse than being down.
  if [ -f "$PIDFILE" ]; then
    claimed=$(head -1 "$PIDFILE" 2>/dev/null)
    if pgrep -x postgres >/dev/null 2>&1 || pgrep -x postmaster >/dev/null 2>&1; then
      echo "[watchdog] a postmaster IS running — leaving the pid file alone"
    elif [ -n "$claimed" ] && ps -p "$claimed" -o command= 2>/dev/null | grep -qi postgres; then
      echo "[watchdog] PID $claimed really is postgres — leaving the pid file alone"
    else
      owner=$(ps -p "${claimed:-0}" -o command= 2>/dev/null | head -c 60)
      echo "[watchdog] stale pid file (claims $claimed${owner:+, which is now: $owner}) — clearing"
      cp "$PIDFILE" "/tmp/postmaster.pid.stale-$(date +%s)" 2>/dev/null
      rm -f "$PIDFILE"
    fi
  fi

  brew services restart postgresql@16 >/dev/null 2>&1
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pg_isready -h localhost -p 5432 >/dev/null 2>&1 && break
    sleep 2
  done

  if pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
    echo "[watchdog] $(date '+%F %T') postgres recovered"
  else
    # Do not carry on reviving app servers that cannot reach a database — they
    # would come up healthy-looking and fail every request.
    echo "[watchdog] $(date '+%F %T') POSTGRES STILL DOWN — needs a human. See /opt/homebrew/var/log/postgresql@16.log"
    exit 1
  fi
fi

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
