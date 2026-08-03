-- Add the always-on 'pot' commission role (S567).
--
-- WHY: on top of the 25¢ closing + 25¢ service split, a flat 10¢/occupied
-- unit/month always accrues to the shared pot (regardless of staffing). It
-- lands in the SAME pot as any orphaned 25¢ halves (no closer / no service
-- manager). Modeled as a third commission_accruals role so the pot balance
-- stays a single SUM(amount) WHERE to_pot. Total accrual is now 60¢/occupied
-- unit/month (25 + 25 + 10).
--
-- CHECK constraints can't be altered in place — drop + re-add.

ALTER TABLE commission_accruals DROP CONSTRAINT commission_accruals_role_check;
ALTER TABLE commission_accruals ADD CONSTRAINT commission_accruals_role_check
  CHECK (role IN ('closing', 'service', 'pot'));
