-- S642 (Nic): "Calculate interest, have it be paid out as credit where
-- applicable… whether we send it to the landlord and the landlord sends it to
-- the tenant or we send it straight to credit the tenant's balance.
-- Realistically, either way, it ends up in the landlord's pocket. Because they
-- just use it to pay rent."
--
-- Interest has been ACCRUING monthly since S604 and only ever PAID at move-out,
-- through the deposit-return path. Eight states require it paid ANNUALLY while
-- the tenancy continues: AZ (33-1431B), IL (765 ILCS 715/2 and 745/18), MA
-- (c.186 §15B), NJ, NM, OH (5321.16A), PA, RI (31-44-7.1). A tenant three years
-- into a lease in any of them is owed money the platform has calculated and
-- never handed over.
--
-- ONE RULE, NOT THIRTEEN. Every state requires payment at termination; eight
-- additionally require it annually. Paying annually in a termination-only state
-- is not a violation — the tenant simply gets their money sooner, and GAM holds
-- the principal either way. So the platform pays annually wherever anything is
-- owed, and the states that only demand it at the end are satisfied early
-- rather than modelled separately. Fewer things to get wrong.
--
-- CREDIT, NOT CASH. Nic's call and it is the right one: a credit lands on the
-- tenant's balance and comes off their next bill automatically. Cash would mean
-- a payout rail to a tenant GAM may have no account for, to hand them money
-- they are about to hand back as rent.
ALTER TABLE security_deposit_interest_accruals
  ADD COLUMN IF NOT EXISTS paid_at        timestamptz,
  ADD COLUMN IF NOT EXISTS paid_credit_id uuid REFERENCES tenant_credits(id) ON DELETE SET NULL;

-- The guard against paying the same month twice. A sweep that double-pays is
-- worse than one that misses: a miss is caught by the next run, a double-pay is
-- money out the door with a plausible-looking ledger behind it.
CREATE INDEX IF NOT EXISTS idx_sdia_unpaid
  ON security_deposit_interest_accruals (security_deposit_id, accrual_month)
  WHERE paid_at IS NULL;

COMMENT ON COLUMN security_deposit_interest_accruals.paid_at IS
  'When this month''s owed interest was handed to the tenant. NULL = still owed. Set by the annual sweep or by the move-out deposit return, never by hand.';

-- 'deposit_interest' is not goodwill and not an overcharge — it is a statutory
-- obligation, and lumping it into "other" would make it invisible in exactly
-- the report an auditor would ask for.
ALTER TABLE tenant_credits DROP CONSTRAINT IF EXISTS tenant_credits_category_check;
ALTER TABLE tenant_credits ADD CONSTRAINT tenant_credits_category_check
  CHECK (category IN ('screening_cap','late_fee_refund','overcharge','goodwill','deposit_interest','other'));
