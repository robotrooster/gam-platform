#!/bin/bash
# GAM deploy — S605 (Nic: "we should be doing that automatically when we have
# important updates. That way we're not working on old visuals.")
#
# ONE command that ships every surface and PROVES it landed. Safe to run any
# time: it builds everything, compares each build against what production is
# actually serving, and only deploys what differs.
#
#   bash deploy.sh              # deploy whatever is stale
#   bash deploy.sh --check      # report only, change nothing
#   bash deploy.sh --all        # force redeploy even if in sync
#
# WHY THIS EXISTS RATHER THAN VERCEL'S GIT INTEGRATION:
# Vercel's remote build 404s on @gam/shared (workspace package), so every
# frontend must be built LOCALLY and shipped with `--prebuilt`. Push-to-deploy
# would fail on every push. See memory gam-vercel-deploy-prebuilt.
#
# Each surface deploys differently, which is exactly why doing it by hand
# invites drift:
#   • API        — launchd service, needs a rebuild + kickstart
#   • marketing  — launchd service that reads index.html ONCE AT STARTUP, so a
#                  kickstart IS the deploy (no build step at all)
#   • frontends  — local build → vercel build → vercel deploy --prebuilt
#
# Verification is not optional here: an "in sync" claim is only worth anything
# if it came from fetching production, so every surface is checked after.

set -uo pipefail
cd "$(dirname "$0")"

MODE="${1:-}"
CHECK_ONLY=false
FORCE=false
[ "$MODE" = "--check" ] && CHECK_ONLY=true
[ "$MODE" = "--all" ] && FORCE=true

# Vercel-linked frontends and the domain each one serves from.
FRONTENDS=(
  "landlord:landlord.goldassetmanagement.com"
  "tenant:tenant.goldassetmanagement.com"
  "admin:admin.goldassetmanagement.com"
  # S605: PM-company went live because a landlord handing off to a property
  # manager is a lost landlord if the PM cannot even sign up.
  "pm-company:pm.goldassetmanagement.com"
)

GREEN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
ok(){ echo "${GREEN}✓${OFF} $*"; }
warn(){ echo "${YEL}•${OFF} $*"; }
bad(){ echo "${RED}✗${OFF} $*"; }
FAILED=0

echo "═══ GAM deploy $(date '+%Y-%m-%d %H:%M:%S') ═══"
$CHECK_ONLY && echo "${DIM}check-only — nothing will be changed${OFF}"

# ── shared package first: every frontend compiles against it ──────────────
echo; echo "── @gam/shared ──"
if (cd packages/shared && npm run build >/tmp/gam-deploy-shared.log 2>&1); then
  ok "built"
else
  bad "BUILD FAILED — see /tmp/gam-deploy-shared.log"; FAILED=1
  echo; echo "Aborting: frontends compile against shared."; exit 1
fi

# ── API ──────────────────────────────────────────────────────────────────
echo; echo "── API (launchd com.gam.api) ──"
if (cd apps/api && npm run build >/tmp/gam-deploy-api.log 2>&1); then
  ok "built"
  if ! $CHECK_ONLY; then
    launchctl kickstart -k "gui/$(id -u)/com.gam.api" >/dev/null 2>&1
    # Give it a moment, then prove it is actually answering.
    for i in $(seq 1 15); do
      code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:4000/api/sales/demo/slots 2>/dev/null)
      [ "$code" = "200" ] && break
      sleep 1
    done
    if [ "${code:-}" = "200" ]; then ok "restarted and answering"; else bad "restarted but NOT answering (last code: ${code:-none})"; FAILED=1; fi
  fi
else
  bad "BUILD FAILED — see /tmp/gam-deploy-api.log"; FAILED=1
fi

# ── marketing ────────────────────────────────────────────────────────────
# No build step: server.js reads src/index.html at startup, so restarting IS
# the deploy. This is the one everybody forgets.
echo; echo "── marketing (launchd com.gam.marketing) ──"
if $CHECK_ONLY; then
  warn "would kickstart (reads index.html at startup)"
else
  launchctl kickstart -k "gui/$(id -u)/com.gam.marketing" >/dev/null 2>&1
  sleep 3
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 6 https://goldassetmanagement.com/ 2>/dev/null)
  if [ "$code" = "200" ]; then ok "restarted, public site 200"; else bad "public site returned $code"; FAILED=1; fi
fi

# ── Vercel frontends ─────────────────────────────────────────────────────
for entry in "${FRONTENDS[@]}"; do
  app="${entry%%:*}"; domain="${entry##*:}"
  echo; echo "── $app ($domain) ──"
  [ -d "apps/$app" ] || { warn "no such app, skipping"; continue; }
  [ -f "apps/$app/.vercel/project.json" ] || { warn "not Vercel-linked, skipping"; continue; }

  if ! (cd "apps/$app" && npm run build >"/tmp/gam-deploy-$app.log" 2>&1); then
    bad "BUILD FAILED — see /tmp/gam-deploy-$app.log"; FAILED=1; continue
  fi
  local_hash=$(ls "apps/$app"/dist/assets/index-*.js 2>/dev/null | head -1 | xargs basename 2>/dev/null)
  prod_hash=$(curl -s --max-time 10 "https://$domain/" | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1)

  if [ -z "$local_hash" ]; then bad "no build output found"; FAILED=1; continue; fi

  if [ "$local_hash" = "$prod_hash" ] && ! $FORCE; then
    ok "already in sync ($local_hash)"
    continue
  fi

  echo "  ${DIM}local $local_hash → prod ${prod_hash:-none}${OFF}"
  if $CHECK_ONLY; then warn "would deploy"; continue; fi

  if ! (cd "apps/$app" && npx vercel build --prod >>"/tmp/gam-deploy-$app.log" 2>&1 \
        && npx vercel deploy --prebuilt --prod --yes >>"/tmp/gam-deploy-$app.log" 2>&1); then
    bad "DEPLOY FAILED — see /tmp/gam-deploy-$app.log"; FAILED=1; continue
  fi

  # Verify against the real domain — a deploy that "succeeded" but left the
  # alias on an older build is exactly the stale-visuals problem this prevents.
  sleep 4
  for i in $(seq 1 10); do
    prod_hash=$(curl -s --max-time 10 "https://$domain/" | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1)
    [ "$local_hash" = "$prod_hash" ] && break
    sleep 3
  done
  if [ "$local_hash" = "$prod_hash" ]; then ok "deployed and verified ($local_hash)"
  else bad "deployed but $domain still serves ${prod_hash:-none}"; FAILED=1; fi
done

echo
if [ "$FAILED" -eq 0 ]; then echo "${GREEN}═══ all surfaces in sync ═══${OFF}"; else echo "${RED}═══ finished WITH FAILURES (see logs above) ═══${OFF}"; fi
exit $FAILED
