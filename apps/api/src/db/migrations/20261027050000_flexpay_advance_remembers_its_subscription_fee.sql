-- A FlexPay advance records the subscription fee it was priced at, separately
-- from the pass-through costs added to it later.
-- (10/26 — a revenue leak the test migration caught.)
--
-- THE BUG.  bookFlexPayFee booked
--
--     amount: Math.min(Number(adv.fee), FLEXPAY_MONTHLY_FEE)
--
-- into platform_revenue_ledger. tenant_fee_amount starts at the month's
-- subscription fee and then GROWS as returned-pull and dispute costs are added
-- to it, so the clamp was how the book separated "GAM's fee" from "Stripe's
-- cost passed through at cost". That worked perfectly while the fee was a flat
-- $25 -- and broke silently the moment pricing moved to the table: a tenant
-- charged $40 had $25 reach the book and $15 of real revenue vanish. On a
-- $2,500 bill pulled on the 4th benefit Wednesday it would be $54 charged and
-- $25 booked.
--
-- Nothing failed. The tests asserting a $25 booking still passed, which is
-- exactly why this needed finding rather than waiting to be noticed.
--
-- THE FIX.  Stop inferring the fee from a ceiling and record it. subscription_fee
-- is stamped once when the cover is written and never touched again;
-- tenant_fee_amount keeps its existing job as the total the tenant owes
-- (subscription + whatever was passed through). The book reads subscription_fee.
--
-- This matters beyond the arithmetic: "every admin money movement lands in one
-- book" and "every dollar counted once" are standing rules, and a clamp that
-- quietly drops the difference breaks both.
--
-- BACKFILL: yes, and it is exact. Every advance that exists today was written
-- while the fee was the flat $25 and before any table pricing, so its
-- subscription fee was $25 -- except where tenant_fee_amount is somehow lower,
-- in which case the lower figure is what was charged and is what the old clamp
-- would have booked. LEAST() reproduces the old behavior precisely, so no
-- historical booking changes.

ALTER TABLE flexpay_advances
  ADD COLUMN IF NOT EXISTS subscription_fee NUMERIC(10,2);

UPDATE flexpay_advances
   SET subscription_fee = LEAST(tenant_fee_amount, 25.00)
 WHERE subscription_fee IS NULL;

COMMENT ON COLUMN flexpay_advances.subscription_fee IS
  'The FlexPay subscription fee this cycle was PRICED at, from flexpay_fee_schedule, stamped at cover and never changed (10/26). GAM''s revenue for the month; platform_revenue_ledger books this. tenant_fee_amount is the TOTAL the tenant owes and grows with pass-through return/dispute costs, which are never GAM earnings.';
