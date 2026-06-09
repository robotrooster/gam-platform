-- S253: FlexCharge landlord-level disqualification.
--
-- When 3 distinct customers file disputes against the same landlord
-- (rolling 90-day window per Nic spec), the landlord gets blocked
-- from offering FlexCharge going forward. Existing open statements
-- still bill out normally; new charges via postFlexChargeTransaction
-- gate on this column. Disqualification has no automatic cooldown —
-- admin manual review unblocks (NULL out the column).
--
-- Mirrors the tenants.flex_deposit_disqualified_until pattern.

ALTER TABLE landlords
  ADD COLUMN flex_charge_disqualified_until  timestamptz,
  ADD COLUMN flex_charge_disqualified_reason text;
