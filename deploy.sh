#!/bin/bash
# GAM deploy — S605 (Nic: "we should be doing that automatically when we have
# important updates. That way we're not working on old visuals.")
#
# ONE command that ships every surface and PROVES it landed. Safe to run any
# time: it builds everything, compares each build against what production is
# actually serving, and only deploys what differs.
#
#   bash deploy.sh              # test, then deploy whatever is stale
#   bash deploy.sh --check      # report only, change nothing
#   bash deploy.sh --all        # force redeploy even if in sync
#   bash deploy.sh --skip-tests # ship without running the suite (says so loudly)
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
SKIP_TESTS=false
for arg in "$@"; do
  [ "$arg" = "--check" ] && CHECK_ONLY=true
  [ "$arg" = "--all" ] && FORCE=true
  # S624: an escape hatch, because a deploy blocked by an unrelated red test
  # during an incident is worse than no gate at all. It PRINTS LOUDLY, so
  # skipping is a thing somebody chose and can be seen to have chosen.
  [ "$arg" = "--skip-tests" ] && SKIP_TESTS=true
done

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

# ── tests, BEFORE anything ships ─────────────────────────────────────────
#
# S624 (Nic asked for this after a red suite shipped twice in S623): deploy.sh
# built, deployed and verified — and never once ran a test. "Verified" meant the
# bytes on the server matched the bytes on disk, which is true and says nothing
# about whether they work.
#
# DB_NAME=gam_test IS NOT OPTIONAL. Running vitest without it points the suite at
# the DEV/PROD database and its cleanup helpers truncate real tables. It is set
# here explicitly rather than trusted to a shell profile.
#
# The gate runs FIRST — before the shared build, before the API build — because
# the point is to fail before anything is published, not after.
if $CHECK_ONLY; then
  echo; echo "── tests ──"; warn "would run the API suite (skipped in --check)"
elif $SKIP_TESTS; then
  echo; echo "── tests ──"
  bad "SKIPPED (--skip-tests). You are shipping code nothing verified."
else
  echo; echo "── tests (API suite, ~8 min) ──"
  if (cd apps/api && DB_NAME=gam_test npx vitest run --reporter=dot) >/tmp/gam-deploy-tests.log 2>&1; then
    ok "$(grep -oE '[0-9]+ passed' /tmp/gam-deploy-tests.log | tail -1) — suite green"
  else
    bad "TESTS FAILED — nothing has been deployed."
    echo
    # Show the actual failures rather than a log path nobody opens.
    grep -E "FAIL|✕|Tests +[0-9]+ failed" /tmp/gam-deploy-tests.log | head -20
    echo
    echo "Full output: /tmp/gam-deploy-tests.log"
    echo "To ship anyway (and you should have a reason): bash deploy.sh --skip-tests"
    exit 1
  fi
fi

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
# S617: THE PUBLIC SITE IS ON VERCEL NOW, not this Mac. goldassetmanagement.com
# and www both point at cname.vercel-dns.com (project gam-marketing), matching
# how the seven other GAM sites are already pointed. Nic moved it because the
# Mac sits somewhere with brownouts and was hosting the public website, the
# database and the API all at once.
#
# To publish a marketing change now:
#   cd apps/marketing && node build.js && node package-output.js \
#     && npx vercel deploy --prebuilt --prod --yes
#
# The launchd service below is left running deliberately: it still serves the
# same pages on :3004, so pointing DNS back at the tunnel restores the old site
# in one step. Recipe: ~/gam-backups/dns-rollback-marketing.md
# The kickstart here no longer affects what the public sees.
# S622: this step used to ONLY kickstart the launchd fallback and then check
# that goldassetmanagement.com returned 200 — a check the Vercel copy passes
# whether or not it contains your change. A terms-of-service edit was reported
# as "all surfaces in sync" while the public page stayed two days stale. The 200
# was true and meaningless. Build and publish to Vercel here, and verify by
# fetching CONTENT, not a status code.
echo; echo "── marketing (Vercel: goldassetmanagement.com) ──"
if $CHECK_ONLY; then
  warn "would build + vercel deploy --prebuilt --prod"
else
  if ! (cd apps/marketing && node build.js && node package-output.js) >/tmp/gam-deploy-marketing.log 2>&1; then
    bad "BUILD FAILED — see /tmp/gam-deploy-marketing.log"; FAILED=1
  elif ! (cd apps/marketing && npx vercel deploy --prebuilt --prod --yes) >>/tmp/gam-deploy-marketing.log 2>&1; then
    bad "VERCEL DEPLOY FAILED — see /tmp/gam-deploy-marketing.log"; FAILED=1
  else
    sleep 4
    # Content check: compare a fingerprint of what we just built against what the
    # public site actually serves, on a legal page (the pages most likely to be
    # edited without a visible layout change).
    local_fp=$(shasum -a 256 apps/marketing/.vercel/output/static/business/terms.html 2>/dev/null | cut -c1-16)
    prod_fp=$(curl -s --max-time 15 https://goldassetmanagement.com/business/terms 2>/dev/null | shasum -a 256 | cut -c1-16)
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 6 https://goldassetmanagement.com/ 2>/dev/null)
    if [ "$code" != "200" ]; then
      bad "public site returned $code"; FAILED=1
    elif [ -z "$local_fp" ]; then
      warn "deployed; no local terms.html to fingerprint against"
    elif [ "$local_fp" = "$prod_fp" ]; then
      ok "deployed and verified (terms byte-identical to local build)"
    else
      # Vercel may serve a cached copy for a few seconds; retry once before failing.
      sleep 8
      prod_fp=$(curl -s --max-time 15 https://goldassetmanagement.com/business/terms 2>/dev/null | shasum -a 256 | cut -c1-16)
      if [ "$local_fp" = "$prod_fp" ]; then ok "deployed and verified (terms byte-identical to local build)"
      else bad "PUBLIC SITE DOES NOT MATCH THE BUILD (local $local_fp vs prod $prod_fp)"; FAILED=1; fi
    fi
  fi
  # The Mac copy on :3004 stays running as the DNS-rollback fallback, so keep it
  # current too — a stale fallback is worse than none.
  launchctl kickstart -k "gui/$(id -u)/com.gam.marketing" >/dev/null 2>&1
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

# ── storefront (self-hosted: {slug}.gam.biz) ─────────────────────────────
# S636: this surface was missing from the deploy entirely. It is not on
# Vercel — apps/storefront/server.js runs under launchd on :3015 behind the
# Cloudflare wildcard tunnel — so the Vercel loop above skipped it and a
# storefront change silently never shipped. Found the hard way: the new
# /apply page built clean, deploy.sh reported "all surfaces in sync", and
# the page was not live.
echo; echo "── storefront (self-hosted: *.gam.biz) ──"
STOREFRONT_PROBE="${STOREFRONT_PROBE_URL:-https://mountain-view-rv-ranch-2843.gam.biz/}"
if ! (cd apps/storefront && npm run build) >/tmp/gam-deploy-storefront.log 2>&1; then
  bad "BUILD FAILED — see /tmp/gam-deploy-storefront.log"; FAILED=1
else
  sf_local=$(ls apps/storefront/dist/assets/index-*.js 2>/dev/null | head -1 | xargs basename 2>/dev/null)
  sf_prod=$(curl -s --max-time 10 "$STOREFRONT_PROBE" | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1)
  if [ -z "$sf_local" ]; then
    bad "no build output found"; FAILED=1
  elif [ "$sf_local" = "$sf_prod" ] && ! $FORCE; then
    ok "already in sync ($sf_local)"
  elif $CHECK_ONLY; then
    warn "would deploy (local $sf_local → prod ${sf_prod:-none})"
  else
    echo "  ${DIM}local $sf_local → prod ${sf_prod:-none}${OFF}"
    # The server reads dist off disk, but it is restarted anyway: a process
    # holding an old in-memory index.html is the same failure the marketing
    # note above describes.
    launchctl kickstart -k "gui/$(id -u)/com.gam.storefront" >/dev/null 2>&1
    for i in $(seq 1 10); do
      sf_prod=$(curl -s --max-time 10 "$STOREFRONT_PROBE" | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1)
      [ "$sf_local" = "$sf_prod" ] && break
      sleep 3
    done
    if [ "$sf_local" = "$sf_prod" ]; then ok "deployed and verified ($sf_local)"
    else bad "restarted but the site still serves ${sf_prod:-none}"; FAILED=1; fi
  fi
fi

echo
if [ "$FAILED" -eq 0 ]; then echo "${GREEN}═══ all surfaces in sync ═══${OFF}"; else echo "${RED}═══ finished WITH FAILURES (see logs above) ═══${OFF}"; fi
exit $FAILED
