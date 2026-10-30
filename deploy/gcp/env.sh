# Shared names for the deploy/gcp scripts (GCP plan C). Sourced, not run.
# Every script is safe to re-run: "already exists" is not an error.

PROJECT=golddoor-gam
REGION=us-west1
REPO=gam                                   # Artifact Registry (docker)
IMAGE_API="$REGION-docker.pkg.dev/$PROJECT/$REPO/api"
IMAGE_STOREFRONT="$REGION-docker.pkg.dev/$PROJECT/$REPO/storefront"

SQL_INSTANCE=gam-pg
SQL_CONN="$PROJECT:$REGION:$SQL_INSTANCE"
UPLOADS_BUCKET=golddoor-gam-uploads
BUILD_BUCKET="${PROJECT}_cloudbuild"      # created by the first `gcloud builds submit`

SA_API="gam-api@$PROJECT.iam.gserviceaccount.com"            # api, scheduler, migrate job
SA_STOREFRONT="gam-storefront@$PROJECT.iam.gserviceaccount.com"
SA_BUILD="gam-build@$PROJECT.iam.gserviceaccount.com"        # Cloud Build
SA_DEPLOYER="gam-deployer@$PROJECT.iam.gserviceaccount.com"  # GitHub Actions (WIF)

GITHUB_REPO=robotrooster/gam-platform

# The production .env lives in Secret Manager as ONE file secret, mounted at
# /secrets/env/.env and read via GAM_ENV_FILE. Values set on the service
# itself (below, per role) win over it — dotenv never overrides.
ENV_SECRET=gam-api-env

g() { gcloud --project "$PROJECT" "$@"; }
# Run a create; treat "already exists" as success.
ensure() { out=$("$@" 2>&1) && { echo "$out" | tail -1; return 0; }; echo "$out" | grep -qiE "already exists|ALREADY_EXISTS|already own it" && { echo "  (exists) $*" | cut -c1-120; return 0; }; echo "$out" >&2; return 1; }
