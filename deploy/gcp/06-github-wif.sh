#!/usr/bin/env bash
# GCP plan C, step 6: let GitHub Actions deploy as gam-deployer without a key
# (Workload Identity Federation). Grants IAM — run it yourself.
#
# The repo is public, so the trust is narrow: only workflow runs on main of
# THIS repository (matched by its numeric id, which survives a rename and
# cannot be squatted) may exchange a token. Forks and PR runs get nothing.
set -euo pipefail
cd "$(dirname "$0")"; . ./env.sh
GITHUB_REPO_ID=1194021377      # gh api repos/robotrooster/gam-platform --jq .id
DEPLOY_REF=refs/heads/main
number=$(g projects describe "$PROJECT" --format='value(projectNumber)')

echo "── pool + provider"
ensure g iam workload-identity-pools create github --location global --display-name "GitHub Actions"
ensure g iam workload-identity-pools providers create-oidc gam-platform --location global \
  --workload-identity-pool github --display-name "robotrooster/gam-platform" \
  --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping "google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref" \
  --attribute-condition "assertion.repository_id=='$GITHUB_REPO_ID' && assertion.ref=='$DEPLOY_REF'"

echo "── gam-deployer ← that repository"
g iam service-accounts add-iam-policy-binding "$SA_DEPLOYER" --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$number/locations/global/workloadIdentityPools/github/attribute.repository_id/$GITHUB_REPO_ID" \
  >/dev/null && echo "  workloadIdentityUser on gam-deployer → $GITHUB_REPO ($DEPLOY_REF)"

echo
echo "GitHub → Settings → Secrets and variables → Actions → Variables:"
echo "  GCP_WIF_PROVIDER = projects/$number/locations/global/workloadIdentityPools/github/providers/gam-platform"
echo "  GCP_DEPLOYER_SA  = $SA_DEPLOYER"
echo "  GCP_DEPLOY_ENABLED = true    (only at cutover — until then deploy.yml skips)"
