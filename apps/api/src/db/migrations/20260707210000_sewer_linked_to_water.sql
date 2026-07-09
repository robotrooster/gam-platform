-- Sewer rides the water meter (Nic, S533).
--
-- There is no such thing as a sewer meter in the field — sewer is
-- billed off water consumption (usage × sewer rate). A standalone
-- sewer submeter would make the reader enter the same number twice.
-- The water meter now carries an optional sewer_rate_per_unit; one
-- water reading produces TWO bills: water (usage × water rate) and
-- sewer (same usage × sewer rate), each with its own per-type tax
-- snapshot and lease-responsibility gate. The deduct-meter case
-- (irrigation water that never enters the sewer) is a second water
-- meter with the sewer rate left empty. Flat monthly sewer charges are
-- lease fees, not meters (lease-is-law).
--
-- Bundled changes (inseparable — the two-bills-per-meter model forces
-- both): utility_bills grows its own utility_type snapshot (previously
-- derived by joining the meter, which can't represent a sewer bill
-- from a water meter), and the idempotency UNIQUE widens to include
-- the type. Backfill: existing bills take their meter's type.

ALTER TABLE utility_meters ADD COLUMN sewer_rate_per_unit numeric;

ALTER TABLE utility_bills ADD COLUMN utility_type text;
UPDATE utility_bills ub SET utility_type = m.utility_type
  FROM utility_meters m WHERE m.id = ub.meter_id;
ALTER TABLE utility_bills ALTER COLUMN utility_type SET NOT NULL;
ALTER TABLE utility_bills ADD CONSTRAINT utility_bills_utility_type_check
    CHECK (utility_type IN ('water','gas','electric','sewer','trash'));

ALTER TABLE utility_bills DROP CONSTRAINT utility_bills_one_per_meter_unit_cycle;
ALTER TABLE utility_bills ADD CONSTRAINT utility_bills_one_per_meter_unit_cycle
    UNIQUE (meter_id, unit_id, billing_cycle_month, utility_type);
