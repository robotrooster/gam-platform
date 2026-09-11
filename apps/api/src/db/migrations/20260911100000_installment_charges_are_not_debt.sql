-- S641 (Nic) — a charge on an installment plan is scheduled, not overdue.
--
--   "Any outstanding charges aside from propane that has an installment loan or
--    installment plan, because otherwise the notification will always be there."
--
-- And, on being shown that propane is not the only one:
--   "Any installment structures should match what I said about the propane.
--    That was a good call, I just wasn't thinking about it."
--
-- Three plans exist today — propane fills, home sales, and FlexDeposit — and
-- each stamps the payment row it bills through. A balance that is SUPPOSED to
-- be outstanding must never make a unit read as delinquent, or the warning is
-- permanent and everyone learns to ignore it.
--
-- A view rather than three NOT EXISTS clauses at every call site: the next
-- installment product is added here once, and nothing has to remember to go
-- looking for the other places. There is exactly one definition of "this charge
-- is on a plan".
CREATE OR REPLACE VIEW v_installment_payments AS
  SELECT payment_id FROM propane_fill_installments WHERE payment_id IS NOT NULL
  UNION
  SELECT payment_id FROM home_sale_installments    WHERE payment_id IS NOT NULL
  UNION
  SELECT payment_id FROM flex_deposit_installments WHERE payment_id IS NOT NULL;

COMMENT ON VIEW v_installment_payments IS
  'S641: every payment row that is one instalment of an agreed plan. Such a charge is scheduled, not overdue — it must not make a unit read as delinquent. Add any new installment product here and every reader follows.';
