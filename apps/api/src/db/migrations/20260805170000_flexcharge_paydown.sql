-- S583 (Nic) — FlexCharge pay-down support.
--
-- Customers can pay MORE than the minimum (pay down / pay in full) to reduce the
-- carried balance and reach the interest-free grace period. GAM's monthly 1.5%/12
-- subscription must be collected exactly ONCE per statement — whether the first
-- dollar arrives via the minimum auto-pull or via an early pay-down. This flag
-- records that GAM's cut for the statement has been taken, so a later payment
-- flows entirely to the merchant.
--
-- No backfill needed (new column, default false; existing statements predate revolving).
ALTER TABLE flex_charge_statements
  ADD COLUMN IF NOT EXISTS gam_fee_settled BOOLEAN NOT NULL DEFAULT FALSE;
