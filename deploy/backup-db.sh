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

# S535: off-Mac copy via iCloud Drive — zero-cost DR that covers the
# correlated-failure cases local disks can't (fire, theft, surge take the
# Mac AND an external drive together). The Studio is already signed into
# iCloud; dumps are ~25MB so the free 5GB tier holds months of nightlies.
ICLOUD_DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs/GAMBackups/db"
if [ -d "$HOME/Library/Mobile Documents/com~apple~CloudDocs" ]; then
  mkdir -p "$ICLOUD_DIR"
  if cp "$OUT" "$ICLOUD_DIR/"; then
    echo "[backup] ✓ off-Mac copy → iCloud Drive/GAMBackups/db"
  else
    echo "[backup] ✗ iCloud copy FAILED" >&2
  fi
  find "$ICLOUD_DIR" -name 'gam-*.dump' -type f -mtime +"$KEEP_DAYS" -print -delete 2>/dev/null
else
  echo "[backup] ! iCloud Drive not available — local copy only" >&2
fi

# S535: uploads/ mirror — signed lease PDFs, tenant ID scans, inspection
# media. These are NOT in Postgres and NOT recreatable; a DB-only backup
# would restore a platform whose lease rows point at missing files.
UPLOADS_SRC="$HOME/gam/apps/api/uploads"
if [ -d "$UPLOADS_SRC" ]; then
  mkdir -p "$DEST/uploads"
  rsync -a --delete "$UPLOADS_SRC/" "$DEST/uploads/" \
    && echo "[backup] ✓ uploads mirror → $DEST/uploads ($(du -sh "$DEST/uploads" | cut -f1))" \
    || echo "[backup] ✗ uploads local mirror FAILED" >&2
  # S536: under launchd, rsync into iCloud's dir fails with "Operation
  # not permitted" (worked fine from an interactive shell). Single-file
  # copies DO work (the DB dump above proves it nightly), so ship the
  # uploads as one compressed tarball instead of a mirror.
  if [ -d "$HOME/Library/Mobile Documents/com~apple~CloudDocs" ]; then
    UP_TAR="$DEST/uploads-$TS.tgz"
    if tar -czf "$UP_TAR" -C "$UPLOADS_SRC" . && cp "$UP_TAR" "$ICLOUD_DIR/"; then
      echo "[backup] ✓ uploads tarball → iCloud ($(du -h "$UP_TAR" | cut -f1))"
    else
      echo "[backup] ✗ uploads iCloud tarball FAILED" >&2
    fi
    find "$DEST" "$ICLOUD_DIR" -name 'uploads-*.tgz' -type f -mtime +"$KEEP_DAYS" -print -delete 2>/dev/null
  fi
fi

# Optional additional off-Mac copy (rclone/aws) — only if configured.
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
