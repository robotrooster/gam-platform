-- S604: stamp the rate BASIS on each accrual row.
--
-- Without it a row is internally inconsistent under the non-flat bases: a
-- Massachusetts row stamps annual_rate_pct = 5.0000 but records an
-- interest_amount computed as MIN(5%, actually earned). Anyone auditing by
-- recomputing principal * rate * days/365 would get a different number and
-- reasonably conclude the engine was broken.
--
-- Storing the basis makes the row self-explanatory: the rate is the statutory
-- headline, the basis says how it was applied, the amount is the result.
--
-- No backfill needed: table has 0 rows (job has never run in production).

ALTER TABLE security_deposit_interest_accruals
  ADD COLUMN IF NOT EXISTS rate_basis text;

ALTER TABLE security_deposit_interest_accruals
  DROP CONSTRAINT IF EXISTS sdi_accruals_rate_basis_check;
ALTER TABLE security_deposit_interest_accruals
  ADD CONSTRAINT sdi_accruals_rate_basis_check
  CHECK (rate_basis IS NULL OR rate_basis IN ('fixed','lesser_of_actual','share_of_actual'));

COMMENT ON COLUMN security_deposit_interest_accruals.rate_basis IS
  'S604: how annual_rate_pct was applied to produce interest_amount. fixed = flat; lesser_of_actual = MIN(rate, earned); share_of_actual = share of earned. NULL when nothing was owed.';
