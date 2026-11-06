-- 10/28 (Nic) — EVERY FLEXDEPOSIT ROW NAMES THE DEPOSIT IT BELONGS TO.
--
-- The landlord's rendering of a move-in bill has to show the deposit IN FULL
-- and read PAID IN FULL from the first installment:
--
--   "The landlord sees the full move-in fees, first month's rent, last month's
--    rent, security deposits, all that stuff. When the tenant pays it, the
--    tenant is paying that full thing, but just the first installment of the
--    security deposit."
--
--   "the landlord sees the amount of the invoice in total and when it gets
--    paid, it looks like it's paid in full, even when only the first
--    installment is done."
--
-- That rendering has to know which charges are a FlexDeposit plan's, because
-- the plan writes SEVEN kinds of payment row and only ONE of them (installment
-- 1) belongs on the landlord's bill:
--
--   installment 1          deposit, ON the invoice  → stands for the WHOLE deposit
--   the part above the grid deposit, off invoice     → already inside that figure
--   installments 2..N      deposit, off invoice     → already inside that figure
--   a voluntary pay-ahead  deposit, off invoice     → already inside that figure
--   a move's top-up        deposit, off invoice     → already inside that figure
--   the service fee        fee, revenue_owner 'gam' → GAM's money, never theirs
--   a move's top-up fee    fee, revenue_owner 'gam' → GAM's money, never theirs
--
-- Until now the only thing tying those rows to the plan was ENGLISH in the
-- notes ("FlexDeposit voluntary pay-ahead (deposit <uuid>)"), and the only way
-- to recognise one in SQL was moneyPredicates.notFlexDepositRowSql — which
-- asks whether the row's LEASE has a FlexDeposit deposit, not whether the ROW
-- is part of the plan. That is accurate enough to keep the desk from taking
-- custody money, which is what it was written for, but not to decide what a
-- landlord's bill says: a deposit charge that is genuinely theirs, on a lease
-- that later enrolled, reads the same as GAM's collection.
--
-- So the row says so itself. One nullable pointer, set by the code that writes
-- the row, and the rendering keys on it exactly instead of parsing prose or
-- guessing from the lease.
--
-- No backfill needed: no FlexDeposit plan exists in production yet
-- (security_deposits.flex_deposit_enabled is TRUE nowhere), so there is no
-- historical row to name. Nullable and additive — the column is written by the
-- FlexDeposit paths only, and every other payment row keeps it NULL forever.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS flex_deposit_security_deposit_id UUID
    REFERENCES security_deposits(id) ON DELETE SET NULL;

COMMENT ON COLUMN payments.flex_deposit_security_deposit_id IS
  'The FlexDeposit security deposit this charge collects for, set by the '
  'FlexDeposit paths that write the row (installments, the part above the '
  'price grid, pay-aheads, move top-ups, and GAM''s service fees). NULL on '
  'every other payment. The landlord''s rendering of a bill reads it to show '
  'the deposit in full on installment 1 and to leave the plan''s other '
  'collections — which are already inside that figure, or are GAM''s own '
  'revenue — off their bill entirely.';

CREATE INDEX IF NOT EXISTS idx_payments_flex_deposit_deposit
  ON payments (flex_deposit_security_deposit_id)
  WHERE flex_deposit_security_deposit_id IS NOT NULL;
