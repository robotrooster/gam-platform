-- W-56 (work-trade walkthrough, S531, Nic): the monthly hours target moves
-- from the PROPERTY to the AGREEMENT — "hours should be set per person:
-- different rent rates for units and different work being done don't all
-- equally translate." Each approved hour is worth 1/target of THAT
-- tenant's monthly invoice.
--
-- Backfill: existing agreements inherit their property's current target
-- (the value they were effectively running on), so no credit math changes
-- for anyone until the landlord edits a person's target.
-- properties.work_trade_hours_target STAYS as the default for NEW
-- agreements only (no longer read by the credit engine).

ALTER TABLE work_trade_agreements
  ADD COLUMN monthly_hours_target integer;

UPDATE work_trade_agreements wta
   SET monthly_hours_target = COALESCE(p.work_trade_hours_target, 80)
  FROM units u
  JOIN properties p ON p.id = u.property_id
 WHERE u.id = wta.unit_id;

ALTER TABLE work_trade_agreements
  ALTER COLUMN monthly_hours_target SET NOT NULL,
  ALTER COLUMN monthly_hours_target SET DEFAULT 80,
  ADD CONSTRAINT work_trade_agreements_target_positive CHECK (monthly_hours_target > 0);
