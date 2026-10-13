-- 10/13 (Nic) — A DISPUTED GAM FEE PULL POSTS TO THE BOOKS, WITHIN THE MINUTE
--
-- Nic, 10/13: "GAM fee pull disputed by landlord's bank: AUTOMATIC — the
-- disputed fees reopen as owed by the landlord, collected on the next pull,
-- admin told." The money side is migration 20261015130100 and
-- services/landlordGamDebit handleGamDebitDispute: the pull is stamped
-- disputed_at, the fees it collected are owed again, its own $6 cost line is
-- voided, and what the dispute cost is its own GAM charge.
--
-- The books follow (services/ledgerProjectors/payoutGamCharges, source
-- 'gam_debit'): a disputed pull posts a second posting of its own, on the
-- dispute's day — the bank money coming back (Outstanding checks and debits,
-- 2015, until the bank line of the return clears it) and Due to GAM (2080)
-- owed again, by property, for everything the pull had paid. The voided $6
-- and the dispute's cost post through their own GAM charges, as on a failed
-- pull. So the pull's posting now reads landlord_gam_debits.disputed_at, and
-- a change of it marks the pull:
--   landlord_gam_debits  + disputed_at (APPENDED)
-- Columns are appended in the same order as LEDGER_CAPTURE_COLUMNS in
-- packages/shared/src/booksLedger.ts (services/ledgerCoverage.test.ts holds
-- the trigger list and the shared list equal). The other dispute_* columns
-- are not read by any posting (the dispute cost is a landlord_gam_charges row,
-- captured there), so writing them marks nothing.
-- Re-installing a capture replaces its three trigger bodies only
-- (ledger_install_capture, 20261013200600): no table lock beyond a write's.
-- Expand-only; safe to apply before the code ships. No backfill needed: no
-- pull has been disputed on production, and the next rebuild reads every row.
-- Safe drop: re-install the capture as 20261013200600 left it.

SET LOCAL lock_timeout = '10s';

SELECT ledger_install_capture('landlord_gam_debits',
  ARRAY['landlord_id', 'charges_amount', 'bank_cost_amount', 'total_amount', 'status', 'charge_ids', 'settled_at',
        'disputed_at'],
  $k$SELECT 'gam_debit'::text, r.id::text, r.landlord_id$k$);

-- Everything installed still matches its table.
SELECT ledger_check_capture();
