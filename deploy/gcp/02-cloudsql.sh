#!/usr/bin/env bash
# GCP plan C, step 2: the Cloud SQL instance (~$110/month: 2 vCPU / 8 GB,
# 50 GB SSD, daily backups + 7 days of point-in-time recovery). Zonal; HA
# doubles the price and can be switched on later without a dump/restore.
#
# The app user's password is generated here straight into Secret Manager
# (gam-db-password) — never printed, never in a file. The dev password in the
# public repo is NOT reused: it is burned.
#
# Data and the read-only role on gam_properties come in phase D (the dump
# from the Mac carries the roles' grants).
set -euo pipefail
cd "$(dirname "$0")"; . ./env.sh

echo "── instance $SQL_INSTANCE (takes ~10 minutes the first time)"
# No authorized networks and connector-only TLS: the only way in is the Cloud
# SQL connector with an IAM identity that holds cloudsql.client.
ensure g sql instances create "$SQL_INSTANCE" \
  --database-version=POSTGRES_16 --edition=ENTERPRISE --tier=db-custom-2-8192 \
  --region="$REGION" --availability-type=ZONAL \
  --storage-type=SSD --storage-size=50GB --storage-auto-increase \
  --backup-start-time=10:00 --enable-point-in-time-recovery \
  --retained-backups-count=14 --retained-transaction-log-days=7 \
  --ssl-mode=TRUSTED_CLIENT_CERTIFICATE_REQUIRED \
  --maintenance-window-day=SUN --maintenance-window-hour=11 \
  --deletion-protection \
  --database-flags=cloudsql.iam_authentication=on,max_connections=200
# (10:00 / 11:00 UTC = 3–4 AM Phoenix, outside every cron that matters.)

echo "── databases"
ensure g sql databases create gam            --instance "$SQL_INSTANCE"
ensure g sql databases create gam_properties --instance "$SQL_INSTANCE"

echo "── app user gam_app (password → Secret Manager $DB_PASSWORD_SECRET)"
if g secrets describe "$DB_PASSWORD_SECRET" >/dev/null 2>&1; then
  echo "  (exists) $DB_PASSWORD_SECRET — not rotated"
else
  pw=$(openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-40)
  printf '%s' "$pw" | g secrets create "$DB_PASSWORD_SECRET" --replication-policy=automatic --data-file=- >/dev/null
  echo "  $DB_PASSWORD_SECRET created"
fi
pw=$(g secrets versions access latest --secret "$DB_PASSWORD_SECRET")
if g sql users list --instance "$SQL_INSTANCE" --format='value(name)' | grep -qx gam_app; then
  g sql users set-password gam_app --instance "$SQL_INSTANCE" --password "$pw" >/dev/null
  echo "  gam_app password synced"
else
  g sql users create gam_app --instance "$SQL_INSTANCE" --password "$pw" >/dev/null
  echo "  gam_app created"
fi
unset pw

echo "done. connection name: $SQL_CONN"
