#!/usr/bin/env bash
# S622: remove a TEST lease and everything it created.
#
# Nic: "It's not a real tenant. It's not a real lease. It's just testing the
# real workflow." A test signature produces the same rows a real one does — a
# lease, a move-in invoice, charges, a tenancy on the unit — and none of it
# should survive the test. GAM never erases a real record; this is for records
# that were never real.
#
# Usage:  bash scripts/teardown-test-lease.sh <document-id> [--yes]
# Prints exactly what it will remove, and requires --yes to do it.
set -uo pipefail
DOC="${1:-}"; CONFIRM="${2:-}"
[ -z "$DOC" ] && { echo "usage: $0 <document-id> [--yes]"; exit 1; }
DB="${DB_NAME:-gam}"

LEASE=$(psql -d "$DB" -t -A -c "SELECT lease_id FROM lease_documents WHERE id='$DOC'")
UNIT=$(psql -d "$DB" -t -A -c "SELECT unit_id FROM lease_documents WHERE id='$DOC'")
[ -z "$UNIT" ] && { echo "No such document: $DOC"; exit 1; }

echo "── would remove ──"
psql -d "$DB" -t -A -F' | ' <<SQL
SELECT 'document  '||title||'  ('||status||')' FROM lease_documents WHERE id='$DOC';
SELECT 'lease     '||id||'  '||status FROM leases WHERE id='$LEASE';
SELECT 'invoice   '||invoice_number||'  \$'||total_amount FROM invoices WHERE lease_id='$LEASE';
SELECT 'charge    '||type||'  \$'||amount||'  ('||status||')' FROM payments WHERE lease_id='$LEASE';
SELECT 'lease fee '||fee_type||'  \$'||amount FROM lease_fees WHERE lease_id='$LEASE';
SELECT 'tenancy   '||count(*)::text||' lease_tenants row(s)' FROM lease_tenants WHERE lease_id='$LEASE';
SELECT 'unit      '||unit_number||' → back to vacant' FROM units WHERE id='$UNIT';
SQL

# Refuse if any money actually moved — a settled payment means this was not a test.
SETTLED=$(psql -d "$DB" -t -A -c "SELECT COUNT(*) FROM payments WHERE lease_id='$LEASE' AND (status='settled' OR stripe_payment_intent_id IS NOT NULL)")
if [ "${SETTLED:-0}" != "0" ]; then
  echo; echo "REFUSING: $SETTLED payment(s) on this lease reached Stripe or settled."
  echo "Money moved, so this is not a test lease. Nothing removed."
  exit 2
fi

[ "$CONFIRM" != "--yes" ] && { echo; echo "Nothing removed. Re-run with --yes to confirm."; exit 0; }

psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
DELETE FROM remittance_applications WHERE payment_id IN (SELECT id FROM payments WHERE lease_id='$LEASE');
DELETE FROM payments  WHERE lease_id='$LEASE';
DELETE FROM invoices  WHERE lease_id='$LEASE';
DELETE FROM lease_fees WHERE lease_id='$LEASE';
DELETE FROM lease_tenants WHERE lease_id='$LEASE';
DELETE FROM lease_document_fields  WHERE document_id='$DOC';
DELETE FROM lease_document_signers WHERE document_id='$DOC';
UPDATE lease_documents SET lease_id=NULL WHERE id='$DOC';
DELETE FROM leases WHERE id='$LEASE';
DELETE FROM lease_documents WHERE id='$DOC';
UPDATE units SET status='vacant', updated_at=NOW() WHERE id='$UNIT';
COMMIT;
SQL
echo "── removed. Unit is vacant again. ──"
