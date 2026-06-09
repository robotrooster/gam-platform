-- S119: stripe_transfer_id on user_balance_ledger.
--
-- Under Connect Express + destination charges (S116), the PM cut entries
-- written by the allocation engine (S110), monthly accrual (S111), and
-- leasing-fee hook (S111) are "ghost" rows: the ledger says PM company
-- received money, but the actual money landed in the landlord's Connect
-- account at charge time.
--
-- S119 fires a Stripe Transfer from the platform to the PM company's
-- Connect account for each cut, then stamps the resulting transfer id
-- on the ledger row for traceability + idempotency. Subsequent re-runs
-- of the same allocation skip rows that already have a transfer id.
--
-- The column is generic — works for any future ledger entry type that
-- triggers a Stripe Transfer (manager fee for opt-in managers, etc.).

ALTER TABLE user_balance_ledger
  ADD COLUMN stripe_transfer_id text;

-- Partial UNIQUE: prevent duplicate transfers per ledger row, but allow
-- many NULL rows (rows that don't yet have a transfer fired against them).
CREATE UNIQUE INDEX idx_user_balance_ledger_stripe_transfer_id
  ON user_balance_ledger(stripe_transfer_id)
  WHERE stripe_transfer_id IS NOT NULL;
