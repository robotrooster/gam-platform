#!/bin/bash
# GCP migration — collect everything the migration needs from the production
# Mac into ONE encrypted disk image (see GCP_MIGRATION_PLAN.md, "Needed from
# the Mac").
#
# READ-ONLY on production: it stops nothing, changes nothing, and pg_dump runs
# against the live database without locking out writes. Safe to run any time;
# the uploads copy is the slow part, so evenings are kinder.
#
#   bash scripts/gcp-handoff-bundle.sh                 # everything except the uploads files
#   bash scripts/gcp-handoff-bundle.sh --with-uploads  # also copy every uploaded file
#
# Output: ~/Desktop/gam-gcp-handoff-<date>.dmg, AES-256 encrypted. macOS asks
# for a password when the image is built — send the .dmg one way (Drive,
# AirDrop) and the password another (password manager, phone). It holds the
# production secrets and tenants' ID documents: never email it, never Slack it.

set -uo pipefail
export PATH="/opt/homebrew/opt/postgresql@16/bin:/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REPO="${GAM_REPO:-$HOME/gam}"
ENV_FILE="$REPO/apps/api/.env"
WITH_UPLOADS=0
[ "${1:-}" = "--with-uploads" ] && WITH_UPLOADS=1

STAMP="$(date +%Y-%m-%d_%H%M)"
NAME="gam-gcp-handoff-$STAMP"
WORK="$(mktemp -d)/$NAME"
OUT="$HOME/Desktop/$NAME.dmg"
mkdir -p "$WORK"/{env,system,db,uploads,services}
chmod 700 "$WORK"
LOG="$WORK/RUN_LOG.txt"

say()  { echo "[handoff] $*" | tee -a "$LOG"; }
# Run a command, save its output to a file, never abort the whole bundle.
grab() { local out="$1"; shift; { echo "\$ $*"; "$@"; } > "$out" 2>&1 || echo "  (exit $?: $*)" >> "$LOG"; }

[ -d "$REPO" ] || { echo "Repo not found at $REPO — set GAM_REPO=/path/to/gam"; exit 1; }
say "bundle $NAME from $REPO (uploads files: $([ $WITH_UPLOADS = 1 ] && echo yes || echo no))"

# ── 1. Secrets & config ────────────────────────────────────────────────────
say "1/6 env files"
[ -f "$ENV_FILE" ] && cp "$ENV_FILE" "$WORK/env/api.env" || say "  !! $ENV_FILE missing"
# Every other .env* in the repo (frontends, storefront, property-api…), paths preserved.
(cd "$REPO" && find . -name '.env*' -not -path '*/node_modules/*' -not -name '.env.example' -type f) \
  | while read -r f; do mkdir -p "$WORK/env/repo/$(dirname "$f")"; cp "$REPO/$f" "$WORK/env/repo/$f"; done

# ── 2. What is actually running ────────────────────────────────────────────
say "2/6 system + running services"
grab "$WORK/system/git_head.txt"      git -C "$REPO" log -1 --format='%H %ad %s' --date=iso
grab "$WORK/system/git_status.txt"    git -C "$REPO" status
grab "$WORK/system/git_branch.txt"    git -C "$REPO" branch -vv
grab "$WORK/system/git_stash.txt"     git -C "$REPO" stash list
# Uncommitted changes as patches — if prod runs code that was never committed, this is the only copy.
git -C "$REPO" diff          > "$WORK/system/uncommitted.patch"        2>/dev/null
git -C "$REPO" diff --cached > "$WORK/system/uncommitted_staged.patch" 2>/dev/null
git -C "$REPO" ls-files --others --exclude-standard > "$WORK/system/untracked_files.txt" 2>/dev/null
grab "$WORK/system/versions.txt"      bash -c 'sw_vers; echo; node -v; npm -v; psql --version; pg_dump --version; cloudflared --version 2>/dev/null'
grab "$WORK/system/launchctl.txt"     bash -c 'launchctl list | grep -i gam'
grab "$WORK/system/crontab.txt"       crontab -l
grab "$WORK/system/brew_services.txt" brew services list
grab "$WORK/system/listening_ports.txt" bash -c 'lsof -nP -iTCP -sTCP:LISTEN | grep -Ei "node|python|postgres|cloudflared|llama|mlx|COMMAND"'
grab "$WORK/system/processes.txt"     bash -c 'ps axo pid,etime,command | grep -Ei "gam|node|mlx|llama|cloudflared|postgres" | grep -v grep'
grab "$WORK/system/disk.txt"          df -h
mkdir -p "$WORK/services/LaunchAgents"
cp "$HOME"/Library/LaunchAgents/com.gam.* "$WORK/services/LaunchAgents/" 2>/dev/null || say "  (no com.gam.* LaunchAgents)"

# Cloudflare tunnel: the ingress rules list every hostname the Mac serves.
# The tunnel credentials JSON / cert.pem are deliberately NOT copied.
[ -f "$HOME/.cloudflared/config.yml" ] && cp "$HOME/.cloudflared/config.yml" "$WORK/services/cloudflared_config.yml" \
  || say "  (no ~/.cloudflared/config.yml — tunnel may be dashboard-managed; screenshot its Public Hostnames)"
grab "$WORK/services/cloudflared_tunnels.txt" cloudflared tunnel list

# Which models are actually being served.
grab "$WORK/services/llm_models.json"        curl -s --max-time 5 http://localhost:8080/v1/models
grab "$WORK/services/embeddings_models.json" curl -s --max-time 5 http://localhost:8081/v1/models
grab "$WORK/services/models_dir.txt"         ls -la "$HOME/models"
grab "$WORK/services/property_api_4001.txt"  bash -c 'lsof -nP -iTCP:4001 -sTCP:LISTEN; curl -s --max-time 5 http://localhost:4001/health'
grab "$WORK/services/api_health.txt"         curl -s --max-time 5 http://localhost:4000/health
grab "$WORK/services/backups_dir.txt"        ls -la "$HOME/gam-backups"

# ── 3. Database facts ──────────────────────────────────────────────────────
say "3/6 database facts"
# Connect the way the API does: DB_* from the .env (never echoed), else the local socket.
envval() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
export PGHOST="$(envval DB_HOST)"; export PGPORT="$(envval DB_PORT)"
export PGUSER="$(envval DB_USER)"; export PGPASSWORD="$(envval DB_PASSWORD)"
for v in PGHOST PGPORT PGUSER PGPASSWORD; do [ -z "${!v}" ] && unset "$v"; done
MAIN_DB="$(envval DB_NAME)"; MAIN_DB="${MAIN_DB:-gam}"
PROPS_DB="$(envval PROPERTIES_DB_NAME)"; PROPS_DB="${PROPS_DB:-gam_properties}"

psql -d "$MAIN_DB" -Atc 'select 1' >/dev/null 2>&1 || say "  !! cannot connect to $MAIN_DB — dumps below will fail; check DB_* in $ENV_FILE"
grab "$WORK/db/server_version.txt" psql -d "$MAIN_DB" -Atc 'select version()'
grab "$WORK/db/databases.txt"      psql -d "$MAIN_DB" -c "select datname, pg_size_pretty(pg_database_size(datname)) size from pg_database where not datistemplate order by 1"
grab "$WORK/db/roles.txt"          psql -d "$MAIN_DB" -c '\du'
grab "$WORK/db/extensions_$MAIN_DB.txt"  psql -d "$MAIN_DB"  -c '\dx'
grab "$WORK/db/extensions_$PROPS_DB.txt" psql -d "$PROPS_DB" -c '\dx'
grab "$WORK/db/migrations.txt"     psql -d "$MAIN_DB" -c "select count(*) applied, max(applied_at) last_applied from schema_migrations"
grab "$WORK/db/migrations_last20.txt" psql -d "$MAIN_DB" -c "select * from schema_migrations order by applied_at desc limit 20"
grab "$WORK/db/row_counts.txt"     psql -d "$MAIN_DB" -c "select relname, n_live_tup from pg_stat_user_tables order by n_live_tup desc limit 60"
grab "$WORK/db/sanity.txt"         psql -d "$MAIN_DB" -c "select (select count(*) from users) users, (select count(*) from leases) leases, (select count(*) from payments) payments"
# Roles and grants (no password hashes) so Cloud SQL gets the same roles.
grab "$WORK/db/globals_roles.sql"  pg_dumpall --roles-only --no-role-passwords

# ── 4. Database dumps ──────────────────────────────────────────────────────
say "4/6 pg_dump (live, non-blocking)"
for db in "$MAIN_DB" "$PROPS_DB" gam_demo; do
  psql -d "$MAIN_DB" -Atc "select 1 from pg_database where datname='$db'" | grep -q 1 || { say "  (no database $db)"; continue; }
  say "  dumping $db…"
  if pg_dump -Fc -d "$db" -f "$WORK/db/$db.dump" 2>>"$LOG"; then
    say "  ✓ $db $(du -h "$WORK/db/$db.dump" | cut -f1)"
  else
    say "  !! pg_dump $db FAILED (see log above)"
  fi
done
[ -f "$REPO/deploy/demo-checkpoint.dump" ] && cp "$REPO/deploy/demo-checkpoint.dump" "$WORK/db/"

# ── 5. Uploads ─────────────────────────────────────────────────────────────
UP="$(envval UPLOADS_ROOT)"; UP="${UP:-$REPO/apps/api/uploads}"
[ -d "$UP" ] || UP="$REPO/uploads"
say "5/6 uploads at $UP"
if [ -d "$UP" ]; then
  grab "$WORK/uploads/sizes.txt"  du -sh "$UP" "$UP"/*
  (cd "$UP" && for d in */; do printf '%8d  %s\n' "$(find "$d" -type f | wc -l)" "$d"; done) > "$WORK/uploads/file_counts.txt"
  # Manifest: every file with size + SHA-256, to verify the GCS copy object-for-object.
  (cd "$UP" && find . -type f -print0 | xargs -0 shasum -a 256) > "$WORK/uploads/manifest_sha256.txt" 2>>"$LOG"
  (cd "$UP" && find . -type f -exec stat -f '%z %N' {} +) > "$WORK/uploads/manifest_sizes.txt" 2>>"$LOG"
  if [ $WITH_UPLOADS = 1 ]; then
    say "  copying uploads files (this is the slow part)…"
    rsync -a "$UP"/ "$WORK/uploads/files/" 2>>"$LOG" && say "  ✓ uploads copied" || say "  !! uploads copy failed"
  fi
else
  say "  !! no uploads directory found — tell Benjamin where uploads live"
fi

# ── 6. Seal ────────────────────────────────────────────────────────────────
say "6/6 sealing"
cat > "$WORK/README.txt" <<EOF
GAM → GCP handoff bundle, $STAMP, from $(hostname).
env/        production .env files (SECRETS)
system/     git state (incl. any uncommitted prod changes), versions, launchd, cron, ports
services/   LaunchAgents, cloudflared ingress, served models, health checks
db/         pg_dump -Fc of each database + version/extensions/roles/migration facts
uploads/    sizes, counts, sha256 manifest$([ $WITH_UPLOADS = 1 ] && echo ', files/ = every uploaded file')
RUN_LOG.txt anything that failed while collecting
EOF
du -sh "$WORK" | tee -a "$LOG"

echo
echo "Choose a password for the encrypted image (send it separately from the file):"
if hdiutil create -quiet -encryption AES-256 -fs APFS -volname "$NAME" -srcfolder "$WORK" -format UDZO "$OUT"; then
  rm -rf "$(dirname "$WORK")"
  echo
  echo "✓ $OUT ($(du -h "$OUT" | cut -f1))"
  echo "  The unencrypted working copy has been deleted."
else
  echo "!! hdiutil failed — the unencrypted copy is still at $WORK. Delete it when done: rm -rf \"$(dirname "$WORK")\""
  exit 1
fi
