-- 10/12 (Nic) — GAM BOOKS LEDGER: A CHANGE TO ANY FACT A POSTING READS RE-POSTS IT
--
--   Nic: "within a minute (+ nightly tie-out check)"
--
-- Design §7: a table's capture columns are the columns its projector reads, so
-- a change to any of them marks the source for posting within the minute.
-- Review of the integrated ledger found three facts the projectors read that
-- a change to, ALONE, never marked — the record would sit wrong until the
-- nightly check found the drift:
--
--   1. home_sale_contracts.activated_at and lease_id — the home-sale posting
--      (design J2) and the opening note (J1 b) are dated by activated_at and
--      tagged with the lease. The backfill and an admin fix set activated_at
--      on its own.
--   2. security_deposits.flex_deposit_enabled / status — whether a lease's
--      deposit row is a FlexDeposit installment (never the landlord's money)
--      is read by the deposit ROW's posting ('payment'), but the capture only
--      marked the deposit record ('security_deposit'). An enroll or cancel now
--      also marks the lease's deposit rows.
--   3. bank_transactions.auto_settle_undo — the bank-match posting (design
--      B5/B6) reads the receipt it names. And the payout's own bank account
--      (design G3) is now read from the bank line matched to it
--      (matched_disbursement_id, services/ledgerProjectors/payoutDisbursement):
--      matching or unmatching a payout's bank line re-posts that payout, old
--      and new alike.
--
-- Columns are APPENDED to each list, in the same order as LEDGER_CAPTURE_COLUMNS
-- in packages/shared/src/booksLedger.ts (services/ledgerCoverage.test.ts holds
-- the trigger lists and the shared list equal).
-- Re-installing a capture replaces its three trigger bodies only
-- (ledger_install_capture, 20261013200600): no table lock beyond a write's.
-- Expand-only; safe to apply before the code ships (the ledger only reads what
-- the drain posts). No backfill needed: the next rebuild reads every row.
-- Safe drop: re-install the three captures with their earlier lists
-- (20261013200600; bank_transactions and security_deposits keys as there).

SET LOCAL lock_timeout = '10s';

-- ── 1. home sales: the day it went active and its lease ─────────────────────
SELECT ledger_install_capture('home_sale_contracts',
  ARRAY['landlord_id', 'unit_id', 'tenant_id', 'sale_price', 'down_payment', 'financed_amount', 'annual_interest_rate',
        'term_months', 'start_month', 'plan_type', 'status', 'cancelled_at', 'paid_off_at', 'created_at',
        'activated_at', 'lease_id'],
  $k$SELECT v.* FROM (VALUES ('home_sale'::text, r.id::text, r.landlord_id),
                           ('opening', r.landlord_id::text, r.landlord_id)) v$k$);

-- ── 2. a FlexDeposit enroll or cancel marks the lease's deposit rows ────────
SELECT ledger_install_capture('security_deposits',
  ARRAY['lease_id', 'tenant_id', 'unit_id', 'total_amount', 'status', 'held_by', 'flex_deposit_enabled',
        'flex_deposit_plan_status', 'carried_from_deposit_id'],
  $k$SELECT 'security_deposit'::text, r.id::text, (SELECT l.landlord_id FROM leases l WHERE l.id = r.lease_id)
      UNION ALL SELECT 'payment', p.id::text, p.landlord_id FROM payments p WHERE p.lease_id = r.lease_id AND p.type = 'deposit'$k$);

-- ── 3. the receipt a bank line names; the payout a bank line is matched to ──
SELECT ledger_install_capture('bank_transactions',
  ARRAY['bank_connection_id', 'landlord_id', 'posted_date', 'amount', 'status', 'matched_payment_id',
        'matched_disbursement_id', 'expense_id', 'landlord_other_income_id', 'auto_settle_undo'],
  $k$SELECT 'bank_match'::text, r.id::text, r.landlord_id
      UNION ALL SELECT 'disbursement', r.matched_disbursement_id::text, r.landlord_id$k$);

-- Everything installed still matches its table.
SELECT ledger_check_capture();
