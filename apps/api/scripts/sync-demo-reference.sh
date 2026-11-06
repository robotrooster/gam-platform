#!/usr/bin/env bash
# Keep gam_demo's REFERENCE data identical to production's.
#
# 10/30 (Nic): "the demo data needs to always run what's live in production.
# They need to be fully in sync... it is the actual production thing. It's just
# seeded with fake data for sales calls."
#
# deploy.sh already gives the demo the same CODE and the same MIGRATIONS. What
# drifted was catalog data that is loaded by hand-run scripts rather than by a
# migration — the disclosure library is the one that bit us: production had 20
# documents, demo had zero, so every demo resident was told their state's
# landlord-tenant act "isn't in the library yet".
#
# Copying from production, NOT re-running the stocking script: that script
# downloads from state government websites (34 network calls). A deploy must
# not depend on another government's web server being up, and the documents are
# already on this machine's disk — both APIs serve them from the same path.
#
# Insert-missing only. disclosure_library_documents has dependents
# (lease_templates, library_coverage_items, disclosure_library_fields), so
# truncate-and-reload would cut rows out from under them.
set -uo pipefail

PROD="${1:-postgresql://postgres:gam_dev_password@localhost:5432/gam}"
DEMO="${2:-postgresql://postgres:gam_dev_password@localhost:5432/gam_demo}"
TABLES="disclosure_library_documents disclosure_library_fields"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

rc=0
for t in $TABLES; do
  psql "$PROD" -X -q -c "\\copy (SELECT * FROM $t) TO '$TMP/$t.csv' WITH CSV" 2>/dev/null || { echo "  ! could not read $t from production"; rc=1; continue; }
  before=$(psql "$DEMO" -X -t -A -c "SELECT count(*) FROM $t" 2>/dev/null || echo 0)
  psql "$DEMO" -X -q <<SQL 2>/dev/null || { echo "  ! could not load $t into demo"; rc=1; continue; }
CREATE TEMP TABLE _in (LIKE $t INCLUDING DEFAULTS);
\\copy _in FROM '$TMP/$t.csv' WITH CSV
INSERT INTO $t SELECT * FROM _in ON CONFLICT (id) DO NOTHING;
SQL
  after=$(psql "$DEMO" -X -t -A -c "SELECT count(*) FROM $t" 2>/dev/null || echo 0)
  echo "  $t: demo $before -> $after"
done
exit $rc
