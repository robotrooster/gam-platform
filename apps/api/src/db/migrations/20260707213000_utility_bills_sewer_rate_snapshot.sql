-- Sewer rate snapshot on bills (S533 — correction: ONE line item).
--
-- Sewer isn't a second bill: the water meter carries one or two rates
-- and the tenant sees ONE line item — charge = usage × (water rate +
-- sewer rate) + base fee. The bill snapshots the sewer rate alongside
-- the water rate (same posture as rate_per_unit, S90) so the audit
-- trail shows how the combined charge was built; tax_amount is the sum
-- of each portion × its own per-type tax rate.
--
-- The utility_type column + widened UNIQUE from 20260707210000 stay:
-- the type snapshot is correct regardless, and the wider key still
-- guarantees one bill per meter/unit/cycle/type.
--
-- No backfill needed: NULL = no sewer component (all existing bills).

ALTER TABLE utility_bills ADD COLUMN sewer_rate_per_unit numeric;
