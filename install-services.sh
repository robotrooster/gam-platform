#!/bin/bash
# S550 — production service installer. Copies the GAM launchd plists into
# ~/Library/LaunchAgents and (re)loads them. Idempotent: safe to re-run
# after editing a plist or rebuilding the API.
#   bash ~/gam/install-services.sh
# Services managed here:
#   com.gam.api        — production API (compiled dist, KeepAlive)  ← S550
#   com.gam.marketing  — public marketing site :3004 (pre-existing)
#   com.gam.tunnel     — Cloudflare tunnel (pre-existing)
#   com.gam.launchset  — login-time portal starter (pre-existing)
#   com.gam.backup / com.gam.watchdog — pre-existing
# Only com.gam.api is (re)installed by default; pass --all to refresh every
# plist from the repo copies.
set -euo pipefail
cd "$(dirname "$0")"
UID_N=$(id -u)
AGENTS="$HOME/Library/LaunchAgents"

install_one() {
  local label="$1"
  echo "— $label"
  cp "$label.plist" "$AGENTS/$label.plist"
  launchctl bootout "gui/$UID_N/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_N" "$AGENTS/$label.plist"
  launchctl kickstart "gui/$UID_N/$label" 2>/dev/null || true
}

install_one com.gam.api
if [ "${1:-}" = "--all" ]; then
  for l in com.gam.marketing com.gam.tunnel com.gam.launchset com.gam.backup com.gam.watchdog; do
    [ -f "$l.plist" ] && install_one "$l"
  done
fi

sleep 3
echo "Listening:"
lsof -nP -iTCP:4000 -sTCP:LISTEN | tail -1
echo "done."
