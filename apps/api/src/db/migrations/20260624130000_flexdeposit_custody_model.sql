-- FlexDeposit: align the schema with the S512 custody model (Consumer ToS § 9.1).
--
-- WHY. FlexDeposit shipped (S246–S262) on an advance/eat-the-gap model: GAM
-- "advanced" the deposit to the landlord and treated unpaid installments as a
-- defaulted balance that could be accelerated (full balance due in a single
-- pull). The signed Consumer ToS § 9.1 now governs a CUSTODY model: the tenant
-- funds their OWN deposit into GAM custody over 2–6 installments, GAM advances
-- nothing, and a missed installment only leaves the deposit under-funded —
-- § 9.1.5 forbids acceleration, debt-collection, or any "balance due in full"
-- demand. This migration retires the advance/acceleration schema vestiges so
-- the data model can no longer represent the superseded states.
--
-- No backfill of real data needed (FlexDeposit is flag-hidden pre-launch via
-- flexdeposit_rollout_visible); the data UPDATEs below only normalize any dev
-- rows left in retired states so the new CHECK constraints apply cleanly.

BEGIN;

-- 1. Installment count range 2..4 → 2..6 (ToS § 9.1.1 discloses "two to six").
ALTER TABLE flex_deposit_installments
  DROP CONSTRAINT IF EXISTS flex_deposit_installments_count_check;
ALTER TABLE flex_deposit_installments
  ADD CONSTRAINT flex_deposit_installments_count_check
  CHECK (installment_count >= 2 AND installment_count <= 6);

-- 2. Installment status: 'defaulted' (debt framing) → 'missed' (custody framing).
--    A missed installment is not a default; it just means that month's
--    contribution to the custody balance did not clear.
UPDATE flex_deposit_installments SET status = 'missed' WHERE status = 'defaulted';
ALTER TABLE flex_deposit_installments
  DROP CONSTRAINT IF EXISTS flex_deposit_installments_status_check;
ALTER TABLE flex_deposit_installments
  ADD CONSTRAINT flex_deposit_installments_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'settled'::text, 'failed'::text, 'missed'::text]));

-- 3. Plan status: drop 'accelerated' and 'in_default' (both belong to the
--    retired model). A plan is either 'active' (funding, possibly under-funded)
--    or 'completed' (fully funded). Normalize any dev rows first.
UPDATE security_deposits
   SET flex_deposit_plan_status = CASE
         WHEN collected_amount >= total_amount THEN 'completed'
         ELSE 'active'
       END
 WHERE flex_deposit_plan_status IN ('accelerated', 'in_default');
ALTER TABLE security_deposits
  DROP CONSTRAINT IF EXISTS security_deposits_plan_status_check;
ALTER TABLE security_deposits
  ADD CONSTRAINT security_deposits_plan_status_check
  CHECK (flex_deposit_plan_status IS NULL
         OR flex_deposit_plan_status = ANY (ARRAY['active'::text, 'completed'::text]));

-- 4. Mark the advance/acceleration columns deprecated. They are no longer
--    written (gam_advance_amount stays at its DEFAULT 0; balance_due_* stay
--    NULL). Kept rather than dropped to preserve historical dev rows; a future
--    cleanup migration may drop them once confirmed empty in every environment.
COMMENT ON COLUMN security_deposits.gam_advance_amount IS
  'DEPRECATED S514: the custody model has no GAM advance — the tenant funds their own deposit. Always 0; retained only for historical rows.';
COMMENT ON COLUMN security_deposits.balance_due_full_at IS
  'DEPRECATED S514: acceleration removed under the custody model (Consumer ToS § 9.1.5). No longer written.';
COMMENT ON COLUMN security_deposits.balance_due_total IS
  'DEPRECATED S514: acceleration removed under the custody model (Consumer ToS § 9.1.5). No longer written.';

COMMIT;
