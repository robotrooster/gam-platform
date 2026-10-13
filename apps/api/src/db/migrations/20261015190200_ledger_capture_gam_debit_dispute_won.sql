-- 10/13 (Nic) — A DISPUTE GAM WINS ON ITS FEE PULL TAKES THE BOOKS' CANCELLATION BACK, WITHIN THE MINUTE
--
-- Nic, 10/13 (afternoon): "Won GAM pull dispute: AUTOMATIC (back to collected;
-- anything collected twice credited back)." The money side is migration
-- 20261015180000 and services/landlordGamDebit applyWonGamDebitDispute: the
-- pull is stamped dispute_won_at, its fees go back to collected, its own $6
-- is un-voided, a charge collected twice meanwhile is given back on the
-- landlord's next payout, and the dispute's cost charge is voided.
--
-- The books follow (services/ledgerProjectors/payoutGamCharges, source
-- 'gam_debit'): a disputed pull's 'cancellation' posting (Dr Outstanding
-- checks and debits / Cr Due to GAM, on the dispute's day — 20261015140100)
-- is wanted only while the dispute is not won, so a win takes it back and the
-- pull's own posting stands, as the money does. The given-back payout lines
-- post through their own held_payout_items rows (payoutHeldItem), the charges
-- through their own landlord_gam_charges rows — both captured already. So the
-- pull's posting now reads landlord_gam_debits.dispute_won_at, and a change of
-- it marks the pull:
--   landlord_gam_debits  + dispute_won_at (APPENDED)
-- Columns are appended in the same order as LEDGER_CAPTURE_COLUMNS in
-- packages/shared/src/booksLedger.ts (services/ledgerCoverage.test.ts holds
-- the trigger list and the shared list equal). The other dispute_won_* and
-- dispute_fee_* columns are not read by any posting, so writing them marks
-- nothing.
-- Re-installing a capture replaces its three trigger bodies only
-- (ledger_install_capture, 20261013200600): no table lock beyond a write's.
--
-- The column is 20261015180000's (the money side), which runs first when both
-- ship. 10/13 review: the books' code reads it (the gam_debit posting, the Due
-- to GAM and Outstanding checks and debits nightly checks), so this file adds
-- it too, the same way (ADD COLUMN IF NOT EXISTS, nullable) — the books ship
-- whole even if the money side is held back (nothing then writes the column,
-- so no pull reads as won), and 20261015180000 arriving later adds nothing
-- twice. Its comment and checks stay 20261015180000's.
--
-- Expand-only; safe to apply before the code ships. No backfill needed: no
-- pull has been disputed on production, and the next rebuild reads every row.
-- Idempotent.
-- Safe drop: re-install the capture as 20261015140100 left it (the column is
-- the money side's to keep).

SET LOCAL lock_timeout = '10s';

ALTER TABLE landlord_gam_debits ADD COLUMN IF NOT EXISTS dispute_won_at timestamptz;

SELECT ledger_install_capture('landlord_gam_debits',
  ARRAY['landlord_id', 'charges_amount', 'bank_cost_amount', 'total_amount', 'status', 'charge_ids', 'settled_at',
        'disputed_at', 'dispute_won_at'],
  $k$SELECT 'gam_debit'::text, r.id::text, r.landlord_id$k$);

-- Everything installed still matches its table.
SELECT ledger_check_capture();
