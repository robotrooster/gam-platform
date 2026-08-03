-- Add 'prior_arrangement' as a manual settlement channel on payments (S568, Nic).
--
-- WHY: during a landlord's ONBOARDING TRANSITION, an imported tenant may have
-- already paid the FIRST period's rent through the prior software / prior
-- arrangement, off-platform. The landlord marks that first invoice as paid via
-- prior arrangement so it comes off the books — no money moves through GAM and
-- NO manual-payment fee is charged (same rationale as the first-payment fee
-- waiver: give the tenant time to finish the ACH transfer + portal setup).
--
-- This is tightly gated (enforced in the route, NOT here): FIRST rent charge
-- only, IMPORTED leases only (a brand-new GAM lease has no prior arrangement),
-- and only within 21 days of onboarding. It is NOT a general cash/check method,
-- so MANUAL_PAYMENT_METHODS (the cash-drawer list) stays cash/check/money_order;
-- we only widen the column CHECK so the settlement channel can be recorded.
--
-- Safe change: widening an allowed-value CHECK. No backfill; existing rows keep
-- their cash/check/money_order/NULL values.

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_manual_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_manual_method_check
  CHECK (manual_method IS NULL OR manual_method IN ('cash', 'check', 'money_order', 'prior_arrangement'));
