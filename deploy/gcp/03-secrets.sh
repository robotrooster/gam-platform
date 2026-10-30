#!/usr/bin/env bash
# GCP plan C, step 3: the production .env → Secret Manager (gam-api-env), as
# one file the API, scheduler and jobs mount at /secrets/env/.env.
#
#   bash deploy/gcp/03-secrets.sh /path/to/prod.env
#
# Run it on the machine that already holds the file (Nic's Mac, or wherever
# the handoff bundle was unpacked). The file never leaves that machine except
# into Secret Manager, and this script prints key NAMES only, never values.
#
# Keys the Cloud Run services set themselves (database, storage, scheduler
# gate, logging, proxy hops — see 04-run.sh) are stripped first: dotenv never
# overrides, but PROPERTIES_DB_HOST=localhost left in the file would still
# beat the fallback to DB_HOST, so nothing here is allowed to compete.
set -euo pipefail
src=${1:?usage: 03-secrets.sh /path/to/prod.env}
[ -f "$src" ] || { echo "no such file: $src" >&2; exit 1; }
cd "$(dirname "$0")"; . ./env.sh

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
STRIP='^(export +)?(DATABASE_URL|PROPERTIES_DATABASE_URL|DB_[A-Z_]*|PROPERTIES_DB_(HOST|PORT|USER|PASSWORD|NAME)|PORT|NODE_ENV|RUN_SCHEDULER|STORAGE_DRIVER|UPLOADS_ROOT|GCS_UPLOADS_BUCKET|LOG_DIR|LOG_TO_STDOUT|TRUST_PROXY_HOPS|GAM_ENV_FILE|SKIP_SCHEMA_DUMP)='
grep -vE "$STRIP" "$src" > "$work/.env" || true

echo "── stripped (set on the service instead):"
grep -oE "$STRIP" "$src" | sed -E 's/^(export +)?//; s/=$//' | sort -u | sed 's/^/  /' || true

# The Mac reaches its model servers on localhost; Cloud Run reaches them
# through the Cloudflare Access hostnames (plan A4). A localhost URL here
# means the assistant, embeddings or auto-placement would silently 503.
bad=$(grep -E '^(export +)?[A-Z_]+=.*(localhost|127\.0\.0\.1|0\.0\.0\.0)' "$work/.env" | sed -E 's/^(export +)?([A-Z_]+)=.*/\2/' || true)
if [ -n "$bad" ]; then
  echo "── these still point at localhost (fix them in the source file, then re-run):" >&2
  echo "$bad" | sed 's/^/  /' >&2
  exit 1
fi
for k in LLM_ENDPOINT EMBEDDINGS_ENDPOINT AUTO_FIELD_MODEL_URL CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET; do
  grep -qE "^(export +)?$k=." "$work/.env" || echo "  note: $k is not set — that feature stays off"
done

echo "── $ENV_SECRET ($(grep -cE '^(export +)?[A-Z_]+=' "$work/.env") keys)"
if ! g secrets describe "$ENV_SECRET" >/dev/null 2>&1; then
  g secrets create "$ENV_SECRET" --replication-policy=automatic >/dev/null
  echo "  created"
fi
g secrets versions add "$ENV_SECRET" --data-file="$work/.env" --format='value(name)' | sed 's/^/  new version: /'
echo "done. Running services keep the version they started with: redeploy (04-run.sh) to pick it up."
