-- The FlexDeposit plan remembers the fee it was sold at.  (10/26, Nic.)
--
-- WHY.  The service fee moved from a $3/month constant to a price read from
-- flexdeposit_fee_schedule, collected in full with installment 1. A constant
-- needed no storage; a table price does. Two paths prove it:
--
--   1. RE-ACCEPTANCE. When the agreement template version bumps, an enrolled
--      tenant re-accepts their populated agreement, rendered from the plan in
--      the database (flexsuiteAcceptance). Without the fee stored, that render
--      has no price to state — and a deposit agreement that says
--      "[Not Provided]" where the fee goes is worse than no agreement.
--   2. A LATER RE-PRICE. The schedule is append-only, so quoting it again on a
--      later date can return a different number. The price a tenant ACCEPTED
--      must keep answering for their plan, not drift to today's.
--
-- So the fee is stamped on the plan at enrollment and read back from there,
-- never re-quoted.
--
-- NOT part of the custody balance. The deposit the landlord may claim against,
-- and that is returned at move-out, is only what the tenant funded toward the
-- deposit itself (security_deposits.collected_amount). This column sits beside
-- that as GAM's revenue and must never be added into it.
--
-- No backfill needed: no FlexDeposit plan exists yet (the product was switched
-- on the same day), so there is no historical fee to reconstruct. A NULL means
-- a plan from before this column, and the agreement renderer refuses rather
-- than inventing a figure.

ALTER TABLE security_deposits
  ADD COLUMN IF NOT EXISTS flex_deposit_service_fee NUMERIC(10,2);

COMMENT ON COLUMN security_deposits.flex_deposit_service_fee IS
  'GAM''s one-time FlexDeposit service fee for this plan, from flexdeposit_fee_schedule at enrollment, collected in full with installment 1 (10/26, Nic). NOT part of collected_amount and never returned to the tenant at move-out. NULL = no FlexDeposit plan, or a plan predating this column.';
