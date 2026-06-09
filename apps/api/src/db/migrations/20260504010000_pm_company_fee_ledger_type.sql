-- S110: extend user_balance_ledger.type CHECK to allow
-- 'allocation_pm_company_fee'.
--
-- The existing 16a allocation engine splits a settled rent payment into
-- (manager fee, owner share, banking spread). When a property is
-- contracted to a third-party PM company (S108/S109 — properties.pm_company_id),
-- the PM company replaces the in-house manager fee at allocation time:
-- the PM cut comes off the splittable amount and posts to the user that
-- owns the pm_company's bank account.
--
-- The ledger entry needs its own type to distinguish it from
-- 'allocation_manager_fee' (in-house manager). Same row shape: per-user,
-- bank_account_id snapshot, property_id reference, payment as
-- reference_id/type. Auto-Friday payouts reuse the same per-user
-- ledger sweep mechanism with no further change.

ALTER TABLE user_balance_ledger
  DROP CONSTRAINT user_balance_ledger_type_check;

ALTER TABLE user_balance_ledger
  ADD CONSTRAINT user_balance_ledger_type_check
  CHECK (type = ANY (ARRAY[
    'allocation_owner_share',
    'allocation_manager_fee',
    'allocation_pm_company_fee',
    'placement_fee',
    'maintenance_markup',
    'withdrawal_auto',
    'withdrawal_manual',
    'withdrawal_fee',
    'adjustment'
  ]));
