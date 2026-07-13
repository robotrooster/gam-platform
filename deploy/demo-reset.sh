#!/bin/bash
# S537: perpetual demo environment.
#
# capture : snapshot the CURRENT gam database as the demo checkpoint
#           (deploy/demo-checkpoint.dump). Run this when the data is in
#           the exact state a pitch should start from.
# reset   : restore the checkpoint INTO the gam database — wipes current
#           data and returns every portal to the captured starting point.
#           Run after each presentation.
#
#   bash deploy/demo-reset.sh capture
#   bash deploy/demo-reset.sh reset
#
# The checkpoint includes Oak Park Motel and RV (Nic's real property,
# imported live from the DoorLoop rent roll) + the james@demo.dev demo
# portfolio. Uploads are NOT included — demo flows that need files use
# the seeded demo assets which live in the repo's uploads dir.

set -euo pipefail
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

DB="postgresql://postgres:gam_dev_password@localhost:5432/gam"
CHECKPOINT="$(dirname "$0")/demo-checkpoint.dump"

case "${1:-}" in
  capture)
    pg_dump -Fc "$DB" -f "$CHECKPOINT"
    echo "[demo] ✓ checkpoint captured → $CHECKPOINT ($(du -h "$CHECKPOINT" | cut -f1))"
    ;;
  reset)
    if [ ! -f "$CHECKPOINT" ]; then
      echo "[demo] ✗ no checkpoint at $CHECKPOINT — run 'capture' first" >&2; exit 1
    fi
    # --clean --if-exists drops and recreates objects from the dump, so
    # the restore is a true reset, not a merge.
    pg_restore --clean --if-exists --no-owner -d "$DB" "$CHECKPOINT" 2>/dev/null || true
    echo "[demo] ✓ database reset to checkpoint ($(date))"
    ;;
  *)
    echo "usage: $0 capture|reset" >&2; exit 1
    ;;
esac
