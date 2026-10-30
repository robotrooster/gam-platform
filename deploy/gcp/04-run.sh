#!/usr/bin/env bash
# GCP plan C, step 4: Cloud Run — the migrate and ops jobs, gam-api,
# gam-storefront and (only when asked) gam-scheduler.
#
#   bash deploy/gcp/04-run.sh <tag>                   # jobs, api, storefront
#   bash deploy/gcp/04-run.sh <tag> --with-scheduler  # …and the cron runner
#
# <tag> is an image tag cloudbuild.yaml pushed (a short commit SHA).
#
# Run it only once the database holds data (phase D): the services boot
# against whatever gam-pg holds. --with-scheduler only at cutover, after the
# Mac's launchd service is stopped — exactly ONE process anywhere runs the
# crons, or rent posts, autopays and late fees run twice.
#
# Cost while running: gam-api ~$105/month (always on, 2 vCPU / 2 GiB),
# gam-scheduler ~$60 (1 vCPU / 2 GiB), storefront pennies (scales to zero).
set -euo pipefail
tag=${1:?usage: 04-run.sh <tag> [--with-scheduler]}
with_scheduler=${2:-}
cd "$(dirname "$0")"; . ./env.sh

# Everything that is not in the .env secret. TRUST_PROXY_HOPS=2: the load
# balancer appends "<client>, <lb>" to X-Forwarded-For. Payment records store
# req.ip, so in staging check that a logged request carries your own IP
# before cutover — a Cloudflare proxy in front would make it 3.
API_ENV="DB_HOST=/cloudsql/$SQL_CONN,DB_NAME=gam,DB_USER=gam_app,PROPERTIES_DB_NAME=gam_properties"
API_ENV+=",STORAGE_DRIVER=gcs,GCS_UPLOADS_BUCKET=$UPLOADS_BUCKET,GAM_ENV_FILE=/secrets/env/.env,TRUST_PROXY_HOPS=2"
API_SECRETS="DB_PASSWORD=$DB_PASSWORD_SECRET:latest,/secrets/env/.env=$ENV_SECRET:latest"
api_common=(--region "$REGION" --image "$IMAGE_API:$tag" --service-account "$SA_API"
  --set-cloudsql-instances "$SQL_CONN" --set-secrets "$API_SECRETS")

echo "── job gam-migrate"
# Before every rollout: CI executes it (--wait) and stops on failure.
#   g run jobs execute gam-migrate --region $REGION --wait
#   g run jobs execute gam-migrate --region $REGION --wait --args dist/db/migrate.js,--status
g run jobs deploy gam-migrate "${api_common[@]}" \
  --set-env-vars "$API_ENV,RUN_SCHEDULER=0" \
  --command node --args dist/db/migrate.js \
  --tasks 1 --max-retries 0 --task-timeout 3600 --cpu 1 --memory 1Gi --quiet

echo "── job gam-ops (one-off CLIs, compiled: pass the script as --args)"
#   g run jobs execute gam-ops --region $REGION --wait --args dist/scripts/ledgerCheck.js
g run jobs deploy gam-ops "${api_common[@]}" \
  --set-env-vars "$API_ENV,RUN_SCHEDULER=0" \
  --command node --args dist/scripts/ledgerCheck.js \
  --tasks 1 --max-retries 0 --task-timeout 3600 --cpu 1 --memory 2Gi --quiet

# /health checks the database, so a revision that cannot reach Cloud SQL
# never takes traffic. No liveness probe on it: a database blip must not
# restart a healthy instance.
PROBE="httpGet.path=/health,httpGet.port=8080,periodSeconds=5,timeoutSeconds=4,failureThreshold=24"

echo "── service gam-api (public through the load balancer only)"
# One instance: rate limits and the ledger's after-commit kick live in
# process. CPU always allocated — background work continues after the
# response, and min=1 is billed by the instance anyway.
g run deploy gam-api "${api_common[@]}" \
  --set-env-vars "$API_ENV,RUN_SCHEDULER=0" \
  --execution-environment gen2 --cpu 2 --memory 2Gi --no-cpu-throttling \
  --min-instances 1 --max-instances 1 --concurrency 80 --timeout 900 \
  --startup-probe "$PROBE" \
  --ingress internal-and-cloud-load-balancing --no-invoker-iam-check --quiet

if [ "$with_scheduler" = "--with-scheduler" ]; then
  echo "── service gam-scheduler (the ONE cron runner; no public ingress)"
  g run deploy gam-scheduler "${api_common[@]}" \
    --set-env-vars "$API_ENV,RUN_SCHEDULER=1" \
    --execution-environment gen2 --cpu 1 --memory 2Gi --no-cpu-throttling \
    --min-instances 1 --max-instances 1 --timeout 900 \
    --startup-probe "$PROBE" \
    --ingress internal --no-allow-unauthenticated --quiet
else
  echo "── gam-scheduler skipped (the Mac still runs the crons; pass --with-scheduler at cutover)"
fi

echo "── service gam-storefront"
g run deploy gam-storefront --region "$REGION" --image "$IMAGE_STOREFRONT:$tag" \
  --service-account "$SA_STOREFRONT" \
  --cpu 1 --memory 512Mi --min-instances 0 --max-instances 4 \
  --ingress internal-and-cloud-load-balancing --no-invoker-iam-check --quiet

echo "done."
