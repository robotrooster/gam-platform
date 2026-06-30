#!/usr/bin/env bash
#
# Install GAM's Mac launchd services — the LAUNCH-TIME switch from the dev stack
# (gam-start.sh / dev.sh, ts-node-dev + vite) to launchd-managed services that
# survive reboots and auto-restart on crash.
#
# Manages: com.gam.model (:8080), com.gam.embeddings (:8081),
#          com.gam.api (:4000, production build), com.gam.backup (nightly dump).
# Postgres stays a Homebrew service. Frontends go to Vercel (separate).
#
# Run only when you're ready to run production-style on the Mac:
#   bash deploy/install-services.sh           # all backend services + backup
#   bash deploy/install-services.sh backup    # just the nightly backup job
#
set -euo pipefail
REPO="/Users/nicholasrhoades/gam"
LA="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"

SAFE="$HOME/gam-services"   # launchd-safe dir (macOS TCC blocks launchd from ~/Downloads)
ALL=(com.gam.model com.gam.embeddings com.gam.api com.gam.backup)
if [ "${1:-}" = "backup" ]; then PLISTS=(com.gam.backup); else PLISTS=("${ALL[@]}"); fi

# Self-contained scripts that launchd runs get copied OUT of the repo so macOS
# TCC doesn't deny them ("Operation not permitted"). These touch only ~/models,
# Postgres, and llama-server — nothing in the repo.
echo "▶ Staging launchd-safe scripts → $SAFE"
mkdir -p "$SAFE"
cp "$REPO/deploy/backup-db.sh"        "$SAFE/backup-db.sh"
cp "$REPO/scripts/start-embeddings.sh" "$SAFE/start-embeddings.sh"
chmod +x "$SAFE/"*.sh

if printf '%s\n' "${PLISTS[@]}" | grep -q com.gam.api; then
  echo "▶ Building shared + API (production dist)…"
  cd "$REPO"
  npm run build --workspace=packages/shared
  npm run build --workspace=apps/api
  echo "▶ Freeing dev ports 8080/8081/4000…"
  for port in 8080 8081 4000; do pid="$(lsof -ti tcp:$port 2>/dev/null)" && [ -n "$pid" ] && kill -9 $pid 2>/dev/null || true; done
  echo ""
  echo "⚠️  com.gam.api runs node against the repo in ~/Downloads, which macOS TCC"
  echo "    blocks for launchd agents. Either move the repo OUT of ~/Downloads (e.g."
  echo "    ~/gam) and re-point the plist + apps/api/.env path, OR grant Full Disk"
  echo "    Access to $(command -v node) in System Settings → Privacy & Security."
  echo "    (model, embeddings, and backup already run from TCC-safe paths.)"
  echo ""
fi

mkdir -p "$LA"
echo "▶ Installing launchd plists → $LA"
for p in "${PLISTS[@]}"; do
  cp "$REPO/deploy/launchd/$p.plist" "$LA/$p.plist"
  launchctl bootout   "gui/$UID_NUM/$p" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$LA/$p.plist"
  echo "  ✓ $p"
done

echo ""
echo "✓ Installed. Services auto-start on boot + restart on crash."
echo "  Check:  launchctl list | grep com.gam"
echo "  Logs:   /tmp/gam-mlx.log  /tmp/gam-embeddings.log  /tmp/gam-api.log  /tmp/gam-backup.log"
echo "  Note:   the Hermes model loads ~27GB (~1-2 min) before the API can use it."
echo "  Uninstall a service:  launchctl bootout gui/$UID_NUM/<label>"
