-- S650 (Nic): "That KPI card doesn't match any of the numbers you said... a
-- whole bunch of shit isn't lining up anywhere."
--
-- Two honest numbers that disagreed:
--   · the Processing Margin card — what tenants actually paid in fees minus
--     what Stripe actually billed GAM for the month ($74.86 for September);
--   · the revenue ledger's per-payment `banking_spread` — the same margin
--     ESTIMATED at charge time against a deliberately conservative cost
--     assumption (2.9% + $0.26), which came to $41.75 for the same month.
--
-- Stripe is on unbundled pricing: it attributes no cost to an individual
-- charge and bills the real cost as daily aggregates, so a per-payment figure
-- can only ever be an estimate. This column remembers what the customer was
-- actually charged on each spread row, so the month can be trued up against
-- Stripe's real invoices and the ledger can equal the card.
ALTER TABLE platform_revenue_ledger ADD COLUMN customer_fee_charged numeric(12,2);

COMMENT ON COLUMN platform_revenue_ledger.customer_fee_charged IS
  'S650: the processing fee the customer actually paid on this charge. Set on banking_spread rows; NULL elsewhere.';
