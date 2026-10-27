-- 10/25 (Nic), on Dominic Gonzalez's contract:
--
--   "For now, with Dominic, we are going to send reminders about that contract
--    payment being due. But it is not going to go billed through the property.
--    It's not going to get invoiced through the property. It's just going to be
--    a ledger that keeps track and when that payment comes in, we will mark
--    that it was paid, but it stays off the books."
--
-- His installment is the TRUST's money, not the park's. Invoicing it through the
-- property would put the trust's money on the park's books and then need
-- unwinding, which is the same reason cards are refused on such a contract. So a
-- contract gets a third thing it can be:
--
--   billed      (default)  — GAM invoices it: its own bill, or the rent bill
--                            where the property bundles them.
--   tracked     this flag  — GAM invoices NOTHING. It keeps the schedule, says
--                            when a payment is due, and records the payment
--                            when somebody marks it. No invoice, no charge, no
--                            money through GAM, nothing on the books.
--
-- The "paid" mark is the column that already exists for this:
-- home_sale_installments.settled_off_platform_at, which GAM has always used for
-- months paid before it started billing — reconcileHomeSaleContract already
-- counts a stamped installment as paid, so payoff and the hand-over of the home
-- work unchanged.
--
-- reminded_at makes the reminder once-per-installment rather than once a night.
--
-- Default FALSE: every existing contract keeps billing exactly as it does now.
-- Expand-only and re-runnable.

ALTER TABLE home_sale_contracts
  ADD COLUMN IF NOT EXISTS tracked_not_billed BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN home_sale_contracts.tracked_not_billed IS
  'TRUE: GAM bills nothing for this contract — no invoice, no charge, no money
   through GAM. It keeps the schedule, reminds when a payment is due, and records
   it when somebody marks it paid (home_sale_installments.settled_off_platform_at).
   For an installment whose money belongs to another set of books: Dominic
   Gonzalez pays the trust, not the park. Default FALSE = GAM invoices it.';

ALTER TABLE home_sale_installments
  ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;

COMMENT ON COLUMN home_sale_installments.reminded_at IS
  'When the buyer was told this payment is due, on a tracked (not billed)
   contract. Stamped once, so the nightly run reminds once per installment and
   not once a night.';

CREATE INDEX IF NOT EXISTS idx_home_sale_installments_to_remind
  ON home_sale_installments (billing_month)
  WHERE payment_id IS NULL AND settled_off_platform_at IS NULL AND reminded_at IS NULL;
