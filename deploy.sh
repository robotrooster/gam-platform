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
#   • frontends  — vercel build --prod → vercel deploy --prebuilt (10/17: one
#                  build, not two — see the note on the parallel stage)
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
  # S648: the standalone register is the same screen as the landlord POS tab
  # (pos-parity.test.ts) and was never shipped by this script, so it silently
  # fell behind every register change.
  "pos:pos.goldassetmanagement.com"
  # S651: both of these were live on their own domains and shipped by NOBODY.
  # admin-ops has been stale since S650 (its staff-only login change never went
  # out); books since it was built. Same failure the storefront note below
  # describes: a surface this script does not know about is a surface that
  # silently keeps serving last month's code.
  "admin-ops:ops.goldassetmanagement.com"
  "books:books.goldassetmanagement.com"
)

GREEN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
ok(){ echo "${GREEN}✓${OFF} $*"; }
warn(){ echo "${YEL}•${OFF} $*"; }
bad(){ echo "${RED}✗${OFF} $*"; }
FAILED=0
# 10/12 review: set when the API did not build, load or answer. Every frontend
# step below is skipped then — see "API first" after the API step.
API_FAILED=0

echo "═══ GAM deploy $(date '+%Y-%m-%d %H:%M:%S') ═══"
$CHECK_ONLY && echo "${DIM}check-only — nothing will be changed${OFF}"

# ── shared package first: every surface compiles against it ───────────────
# 10/17: this moved AHEAD of the tests. It publishes nothing — it writes
# packages/shared/dist and stops — and everything in the parallel stage below
# compiles against that dist, the API suite included (apps/api imports
# @gam/shared through it). Building it once, here, is what lets the suite and
# every surface build run side by side without one rewriting the other's input.
echo; echo "── @gam/shared ──"
if (cd packages/shared && npm run build >/tmp/gam-deploy-shared.log 2>&1); then
  ok "built"
else
  bad "BUILD FAILED — see /tmp/gam-deploy-shared.log"; FAILED=1
  echo; echo "Aborting: every surface compiles against shared."; exit 1
fi

# ── tests and builds, together, BEFORE anything ships ────────────────────
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
# 10/17 (Nic): "these deploys are taking longer and longer they used to take 10
# or 15 minutes and now they're taking 45 minutes." Two changes, both here:
#
#   • The API suite runs on GAM_TEST_WORKERS processes at once, each on its OWN
#     copy of the test database (apps/api/src/test/testWorkers.ts). It used to
#     run all 737 files one after another in a single process because they all
#     shared one database.
#   • Every suite and every surface build starts at the same moment. A build
#     writes to its own dist folder and publishes nothing, so there is no order
#     to keep among them, and a deploy no longer waits out the builds after a
#     suite it could have run beside.
#
# NOTHING SHIPS UNTIL EVERY SUITE IS GREEN. The gate is read below, before the
# first deploy step, and it stops at the FIRST red suite — so a build that
# happened to finish is a dist folder nobody published.
TEST_WORKERS="${GAM_TEST_WORKERS:-6}"
STAGE=/tmp/gam-deploy-stage
rm -rf "$STAGE"; mkdir -p "$STAGE"
# One parallel job: its own log, and its exit code written to a file, because
# `wait` in bash 3.2 (what macOS ships) cannot hand back one named job's status.
stage_run(){ ( eval "$3" >"$2" 2>&1; echo $? >"$STAGE/$1.rc" ) & }
stage_rc(){ cat "$STAGE/$1.rc" 2>/dev/null || echo 99; }
# A red suite stops the deploy here, with the failures themselves on screen
# rather than a log path nobody opens.
gate_suite(){
  if [ "$(stage_rc "$1")" = "0" ]; then
    ok "$2 — $(grep -oE '[0-9]+ passed' "$3" | tail -1)"
    return 0
  fi
  bad "$2 FAILED — nothing has been deployed."
  echo
  grep -E "FAIL|✕|Tests +[0-9]+ failed" "$3" | head -20
  echo
  echo "Full output: $3"
  echo "To ship anyway (and you should have a reason): bash deploy.sh --skip-tests"
  exit 1
}

echo; echo "── tests + builds (in parallel) ──"
if $CHECK_ONLY; then
  warn "would run the API, tenant, landlord, register and PM company suites (skipped in --check)"
elif $SKIP_TESTS; then
  bad "TESTS SKIPPED (--skip-tests). You are shipping code nothing verified."
else
  echo "  ${DIM}API suite on $TEST_WORKERS workers; tenant and landlord portals beside it${OFF}"
  stage_run api-tests /tmp/gam-deploy-tests.log \
    "cd apps/api && DB_NAME=gam_test GAM_TEST_WORKERS=$TEST_WORKERS npx vitest run --reporter=dot"
  # S655 review: the tenant portal's own tests (apps/tenant/vitest.config.ts) —
  # its screens' wording and behavior, which nothing else runs. No database.
  stage_run tenant-tests /tmp/gam-deploy-tests-tenant.log \
    "cd apps/tenant && npx vitest run --reporter=dot"
  # S655: the landlord portal's own tests (apps/landlord/vitest.config.ts) —
  # Record payment, Outstanding Balances, Payments, the Front Desk, Make a bank
  # deposit, move-out and the paid-ahead choice. No database.
  stage_run landlord-tests /tmp/gam-deploy-tests-landlord.log \
    "cd apps/landlord && npx vitest run --reporter=dot"
  # 10/17: the register's own two suites were never run by this script, even
  # though the note on the pos frontend below names pos-parity.test.ts as the
  # reason that surface has to ship — the test that says the standalone
  # register and the landlord POS tab are the same screen. Both are seconds
  # long and both are green, and in this stage they cost no wall clock at all.
  stage_run pos-tests /tmp/gam-deploy-tests-pos.log \
    "cd apps/pos && npx vitest run --reporter=dot"
  # 10/23: apps/pm-company is a one-page door to the landlord portal now (the
  # management portal folded in — PM_FOLD_PLAN.md). Nothing to test: no login,
  # no data, no API call. The surface still BUILDS and deploys below, so the
  # subdomain keeps answering for anybody who has it bookmarked.
fi

# The API's own build (tsc -b). The launchd restart that makes it live is its
# own step further down — this only writes apps/api/dist.
stage_run api-build /tmp/gam-deploy-api.log "cd apps/api && npm run build"

# 10/17: ONE build per frontend, not two. This used to run `npm run build` to
# get a bundle hash to compare against production, and then `vercel build
# --prod` ran the project's build command — the same `tsc && vite build` — all
# over again. Vercel reads framework=vite and buildCommand=null from
# .vercel/project.json, so the two builds produce byte-identical output (checked
# on all seven: same index-<hash>.js). The hash now comes off
# .vercel/output/static, which is also exactly what `--prebuilt` ships.
for entry in "${FRONTENDS[@]}"; do
  app="${entry%%:*}"
  [ -d "apps/$app" ] || continue
  [ -f "apps/$app/.vercel/project.json" ] || continue
  stage_run "build-$app" "/tmp/gam-deploy-$app.log" "cd apps/$app && npx vercel build --prod"
done
stage_run build-storefront /tmp/gam-deploy-storefront.log "cd apps/storefront && npm run build"
# In --check the marketing build is skipped, as it always was: there is nothing
# to compare it against without publishing.
$CHECK_ONLY || stage_run build-marketing /tmp/gam-deploy-marketing.log \
  "cd apps/marketing && node build.js && node package-output.js"
wait

# ── the gate ─────────────────────────────────────────────────────────────
if ! $CHECK_ONLY && ! $SKIP_TESTS; then
  gate_suite api-tests      "API suite green"             /tmp/gam-deploy-tests.log
  gate_suite tenant-tests   "tenant portal suite green"   /tmp/gam-deploy-tests-tenant.log
  gate_suite landlord-tests "landlord portal suite green" /tmp/gam-deploy-tests-landlord.log
  gate_suite pos-tests        "register suite green"      /tmp/gam-deploy-tests-pos.log

fi

# ── API ──────────────────────────────────────────────────────────────────
echo; echo "── API (launchd com.gam.api) ──"
if [ "$(stage_rc api-build)" = "0" ]; then
  ok "built"
  if ! $CHECK_ONLY; then
    # S652: bootout + bootstrap, not kickstart — a kickstart restarts the
    # process but never re-reads the plist, so a changed log path or env var
    # would sit unapplied until the next reboot.
    # Deploy 71 lesson: the first bootstrap right after a bootout can fail with
    # "Input/output error" while launchd is still tearing the old job down, and
    # in that gap the watchdog (com.gam.watchdog) sees :4000 empty and starts
    # the DEV api (ts-node) on the production port. So: bootout, wait for the
    # port to be free, bootstrap until launchd lists the job, then insist on an
    # answer — and if anything but our job holds :4000, say so loudly.
    launchctl bootout "gui/$(id -u)/com.gam.api" >/dev/null 2>&1
    for i in $(seq 1 20); do lsof -nP -iTCP:4000 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 1; done
    # Deploy 72: launchd can take ~30 s after a bootout before it accepts the
    # job again; the earlier 20 s window flagged a deploy that had in fact
    # loaded a moment later. Wait up to two minutes, and re-check at the end.
    # Deploy 73: the loop still reported "not loaded" on a deploy that WAS
    # loaded seconds later, so each attempt now records launchctl's own words
    # (/tmp/gam-deploy-launchd.log) — the next run tells us what launchd said.
    : > /tmp/gam-deploy-launchd.log
    for i in $(seq 1 60); do
      out=$(launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.gam.api.plist" 2>&1); rc=$?
      echo "$(date '+%T') attempt $i rc=$rc ${out}" >> /tmp/gam-deploy-launchd.log
      launchctl print "gui/$(id -u)/com.gam.api" >/dev/null 2>&1 && { echo "$(date '+%T') listed after attempt $i" >> /tmp/gam-deploy-launchd.log; break; }
      sleep 2
    done
    sleep 2
    # Deploy 74 found the real cause of three false alarms: this script runs
    # with pipefail, and `launchctl list | grep -q` lets grep exit on the first
    # match, so launchctl dies of SIGPIPE and the PIPELINE reports failure —
    # for a job that had loaded on attempt 1. `launchctl print` asks launchd
    # directly and pipes nothing.
    if ! launchctl print "gui/$(id -u)/com.gam.api" >/dev/null 2>&1; then bad "launchd did not load com.gam.api (see /tmp/gam-deploy-launchd.log)"; FAILED=1; API_FAILED=1; fi
    # Give it a moment, then prove it is actually answering.
    for i in $(seq 1 60); do
      code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:4000/api/sales/demo/slots 2>/dev/null)
      [ "$code" = "200" ] && break
      sleep 1
    done
    if [ "${code:-}" = "200" ]; then ok "restarted and answering"; else bad "restarted but NOT answering (last code: ${code:-none})"; FAILED=1; API_FAILED=1; fi
    # The thing answering must be OUR job — a ts-node dev process on :4000 is
    # the watchdog's doing and serves source, not the build.
    if lsof -nP -iTCP:4000 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | sort -u | xargs -I{} ps -o command= -p {} 2>/dev/null | grep "ts-node" >/dev/null; then
      bad "a DEV api (ts-node) holds :4000 — kill it and let launchd's com.gam.api take the port"; FAILED=1; API_FAILED=1
    fi
  fi
else
  bad "BUILD FAILED — see /tmp/gam-deploy-api.log"; FAILED=1; API_FAILED=1
fi

# ── API first: no frontend ships in front of an API that did not go live ──
# 10/12 review (deploy order). A frontend is built for the API in this tree. If
# the API step failed, production still runs the OLD API, and a new screen in
# front of it can do the wrong thing rather than merely look wrong: the 10/12
# Team page sends a company-wide-only bookkeeper as "no property", which the
# API before 10/12 read as every property and the whole company. This script
# used to note the failure and deploy every frontend anyway. Now nothing after
# this point ships until the API is live (fix it, then run deploy.sh again).
if [ "$API_FAILED" -ne 0 ]; then
  echo; bad "API did not go live — marketing, every frontend and the storefront are SKIPPED (production keeps their current builds)"
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
if [ "$API_FAILED" -ne 0 ]; then
  warn "skipped: the API did not go live"
elif $CHECK_ONLY; then
  warn "would build + vercel deploy --prebuilt --prod"
else
  if [ "$(stage_rc build-marketing)" != "0" ]; then
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
  if [ "$API_FAILED" -ne 0 ]; then warn "skipped: the API did not go live"; continue; fi
  [ -d "apps/$app" ] || { warn "no such app, skipping"; continue; }
  [ -f "apps/$app/.vercel/project.json" ] || { warn "not Vercel-linked, skipping"; continue; }

  if [ "$(stage_rc "build-$app")" != "0" ]; then
    bad "BUILD FAILED — see /tmp/gam-deploy-$app.log"; FAILED=1; continue
  fi
  # 10/17: the hash comes off .vercel/output/static, which is the build the
  # parallel stage already made and exactly what `--prebuilt` ships.
  local_hash=$(ls "apps/$app"/.vercel/output/static/assets/index-*.js 2>/dev/null | head -1 | xargs basename 2>/dev/null)
  prod_hash=$(curl -s --max-time 10 "https://$domain/" | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1)

  if [ -z "$local_hash" ]; then bad "no build output found"; FAILED=1; continue; fi

  if [ "$local_hash" = "$prod_hash" ] && ! $FORCE; then
    ok "already in sync ($local_hash)"
    continue
  fi

  echo "  ${DIM}local $local_hash → prod ${prod_hash:-none}${OFF}"
  if $CHECK_ONLY; then warn "would deploy"; continue; fi

  if ! (cd "apps/$app" && npx vercel deploy --prebuilt --prod --yes >>"/tmp/gam-deploy-$app.log" 2>&1); then
    bad "DEPLOY FAILED — see /tmp/gam-deploy-$app.log"; FAILED=1; continue
  fi

  # Verify against the real domain — a deploy that "succeeded" but left the
  # alias on an older build is exactly the stale-visuals problem this prevents.
  # 10/17: the flat `sleep 4` before the first try is gone; the loop's own
  # 3-second wait covers an alias that needs a moment, and an alias that is
  # already live costs nothing to confirm.
  for i in $(seq 1 12); do
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
if [ "$API_FAILED" -ne 0 ]; then
  warn "skipped: the API did not go live"
elif [ "$(stage_rc build-storefront)" != "0" ]; then
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
