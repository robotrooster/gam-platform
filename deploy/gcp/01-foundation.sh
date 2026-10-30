#!/usr/bin/env bash
# GCP plan C, step 1: service accounts, image repository, uploads bucket and
# their permissions. No database, no running services — costs pennies.
set -euo pipefail
cd "$(dirname "$0")"; . ./env.sh

echo "── service accounts"
# Checked first: creation is rate-limited per minute, and a create that only
# finds an existing account still counts against it.
make_sa() {
  if g iam service-accounts describe "$1@$PROJECT.iam.gserviceaccount.com" >/dev/null 2>&1; then echo "  (exists) $1"
  else g iam service-accounts create "$1" --display-name "$2" && sleep 5; fi
}
make_sa gam-api        "GAM API, scheduler and migrate job"
make_sa gam-storefront "GAM storefront (no data access)"
make_sa gam-build      "GAM Cloud Build"
make_sa gam-deployer   "GAM deploys from GitHub Actions"

bind() { g projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$1" --role "$2" --condition=None --quiet >/dev/null && echo "  $2 → ${1%%@*}"; }

echo "── image repository"
ensure g artifacts repositories create "$REPO" --repository-format=docker --location="$REGION" \
  --description "GAM API and storefront images"

echo "── uploads bucket (ID scans and other PII: private, versioned, 30-day soft delete)"
ensure g storage buckets create "gs://$UPLOADS_BUCKET" --location="$REGION" \
  --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=30d
g storage buckets update "gs://$UPLOADS_BUCKET" --versioning >/dev/null
# Keep superseded versions 30 days, then drop them.
cat > /tmp/gam-uploads-lifecycle.json <<'JSON'
{"rule":[{"action":{"type":"Delete"},"condition":{"isLive":false,"daysSinceNoncurrentTime":30}}]}
JSON
g storage buckets update "gs://$UPLOADS_BUCKET" --lifecycle-file=/tmp/gam-uploads-lifecycle.json >/dev/null
echo "  gs://$UPLOADS_BUCKET ready"

echo "── gam-api: database, secrets, its own bucket, logs/metrics"
bind "$SA_API" roles/cloudsql.client
bind "$SA_API" roles/cloudsql.instanceUser
bind "$SA_API" roles/secretmanager.secretAccessor
bind "$SA_API" roles/logging.logWriter
bind "$SA_API" roles/monitoring.metricWriter
g storage buckets add-iam-policy-binding "gs://$UPLOADS_BUCKET" \
  --member "serviceAccount:$SA_API" --role roles/storage.objectAdmin >/dev/null && echo "  storage.objectAdmin on $UPLOADS_BUCKET → gam-api"

echo "── gam-storefront: logs only"
bind "$SA_STOREFRONT" roles/logging.logWriter

echo "── gam-build: push images, write logs, read uploaded sources"
bind "$SA_BUILD" roles/logging.logWriter
g artifacts repositories add-iam-policy-binding "$REPO" --location "$REGION" \
  --member "serviceAccount:$SA_BUILD" --role roles/artifactregistry.writer >/dev/null && echo "  artifactregistry.writer on $REPO → gam-build"
ensure g storage buckets create "gs://$BUILD_BUCKET" --location=US --uniform-bucket-level-access
g storage buckets add-iam-policy-binding "gs://$BUILD_BUCKET" \
  --member "serviceAccount:$SA_BUILD" --role roles/storage.objectViewer >/dev/null && echo "  storage.objectViewer on $BUILD_BUCKET → gam-build"

echo "── gam-deployer: submit builds, run the migrate job, deploy services"
bind "$SA_DEPLOYER" roles/cloudbuild.builds.editor
bind "$SA_DEPLOYER" roles/run.admin
bind "$SA_DEPLOYER" roles/serviceusage.serviceUsageConsumer
bind "$SA_DEPLOYER" roles/logging.viewer
g storage buckets add-iam-policy-binding "gs://$BUILD_BUCKET" \
  --member "serviceAccount:$SA_DEPLOYER" --role roles/storage.admin >/dev/null && echo "  storage.admin on $BUILD_BUCKET → gam-deployer"
for sa in "$SA_API" "$SA_STOREFRONT" "$SA_BUILD"; do
  g iam service-accounts add-iam-policy-binding "$sa" \
    --member "serviceAccount:$SA_DEPLOYER" --role roles/iam.serviceAccountUser >/dev/null && echo "  actAs ${sa%%@*} → gam-deployer"
done

echo "done."
