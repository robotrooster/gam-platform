-- S655 money plan M9 (Step 1), K-C undo. Expand-only: added nullable columns,
-- a partial unique index that replaces a plain one with the same effect while
-- nothing is reversed, and two added columns on bank_transactions.
--
-- An automatic deposit settle (one tenant's whole bill to the cent) can be
-- undone. An undone match stamps reversed_at on its allocations, which frees the
-- charge for a different deposit. ux_bank_deposit_allocations_txn_payment (the
-- running code's ON CONFLICT target) stays; re-matching the SAME pair clears
-- reversed_at. The plain unique index on payment_id is dropped only after its
-- partial replacement exists, so there is no moment without the guarantee.
ALTER TABLE bank_deposit_allocations
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid REFERENCES users(id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_bank_deposit_allocations_payment_live
  ON bank_deposit_allocations (payment_id) WHERE reversed_at IS NULL;
DROP INDEX IF EXISTS ux_bank_deposit_allocations_payment;
COMMENT ON COLUMN bank_deposit_allocations.reversed_at IS
  'S655: the match was undone. The charge is free to be matched to a different deposit; this row stays as the record.';

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS auto_settled_at  timestamptz,
  ADD COLUMN IF NOT EXISTS auto_settle_undo jsonb;
COMMENT ON COLUMN bank_transactions.auto_settled_at IS
  'S655: GAM applied this deposit by itself (it equaled exactly one tenant''s whole open bill to the cent). Both sides were told, and the landlord can Undo.';
COMMENT ON COLUMN bank_transactions.auto_settle_undo IS
  'S655: what an automatic deposit settle changed, so Undo restores it exactly: rows (prior status, next_retry_at), late fees zeroed (prior amount, status), late-fee refund credit created, excess paid-ahead credit created, receipt id, declaration, credit-ledger event ids.';
