#!/usr/bin/env bash
#
# GAM Postgres backup — nightly compressed dump + rotation.
# Run by launchd (deploy/launchd/com.gam.backup.plist) on a daily schedule,
# or by hand: `bash deploy/backup-db.sh`.
#
# Restores with:  pg_restore --clean --if-exists -d gam <dump-file>
#
# Env overrides:
#   GAM_DB_NAME          (default: gam)
#   GAM_BACKUP_DIR       (default: $HOME/gam-backups)
#   GAM_BACKUP_KEEP_DAYS (default: 14)
#   GAM_BACKUP_S3_URI    (optional: rclone/aws destination for off-Mac copy)
#
set -uo pipefail
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"

DB="${GAM_DB_NAME:-gam}"
DEST="${GAM_BACKUP_DIR:-$HOME/gam-backups}"
KEEP_DAYS="${GAM_BACKUP_KEEP_DAYS:-14}"

mkdir -p "$DEST"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/gam-$TS.dump"

echo "[backup] $(date '+%F %T') → $OUT"

if ! pg_isready -q; then
  echo "[backup] ✗ Postgres not ready — aborting" >&2
  exit 1
fi

# Custom format (-Fc): compressed, parallel-restorable, schema+data.
if pg_dump -Fc "$DB" -f "$OUT"; then
  SIZE="$(du -h "$OUT" | cut -f1)"
  echo "[backup] ✓ wrote $SIZE"
else
  echo "[backup] ✗ pg_dump FAILED" >&2
  rm -f "$OUT"
  exit 1
fi

# Off-Mac copy (DR) — only if a destination is configured. A backup that lives
# only on the same Mac as the database is not disaster recovery.
if [ -n "${GAM_BACKUP_S3_URI:-}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone copy "$OUT" "$GAM_BACKUP_S3_URI" && echo "[backup] ✓ copied off-Mac via rclone → $GAM_BACKUP_S3_URI"
  elif command -v aws >/dev/null 2>&1; then
    aws s3 cp "$OUT" "$GAM_BACKUP_S3_URI/" && echo "[backup] ✓ copied off-Mac via aws → $GAM_BACKUP_S3_URI"
  else
    echo "[backup] ! GAM_BACKUP_S3_URI set but neither rclone nor aws is installed — local copy only" >&2
  fi
fi

# Rotation: drop local dumps older than KEEP_DAYS.
find "$DEST" -name 'gam-*.dump' -type f -mtime +"$KEEP_DAYS" -print -delete 2>/dev/null
echo "[backup] done — $(ls "$DEST"/gam-*.dump 2>/dev/null | wc -l | tr -d ' ') dump(s) retained in $DEST"
