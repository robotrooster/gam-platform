-- S655 money plan M7 (Step 1), item L. Expand-only: two added nullable columns.
--
-- Keep the old bank: adding a bank never removes the one already verified, so
-- "a bank is waiting on microdeposits" needs its own fact instead of flipping
-- ach_verified off. And the NACHA zero-tolerance block (written on an
-- unauthorized return) is split out of ach_verified, which now only means
-- "has a verified bank".
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS bank_pending_since timestamptz,
  ADD COLUMN IF NOT EXISTS ach_suspended_at   timestamptz;
COMMENT ON COLUMN tenants.bank_pending_since IS
  'S655: a bank is waiting on microdeposit verification. The verified bank(s) already on file stay usable meanwhile.';
COMMENT ON COLUMN tenants.ach_suspended_at IS
  'S655: NACHA zero-tolerance block, written by handle-return. Split out of ach_verified, which now only means "has a verified bank". chargeLeaseBalance refuses ACH while set.';
