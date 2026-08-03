-- units.floor_level (S573, Nic) — a unit's FLOOR PLACEMENT in the building,
-- for tenant search filtering ("ground floor only").
--
-- WHY: a renter with mobility needs (or a preference) searches "ground floor"
-- and must not see upstairs / basement units. This is DISTINCT from
-- is_multi_level (which flags internal stairs for the inspection template): a
-- unit can be single-level yet sit entirely upstairs or in a basement.
--   ground_floor — at grade, no stairs to enter
--   upper_floor  — above grade (2nd+ floor)
--   basement     — below grade
--   multi_floor  — spans floors (e.g. a townhouse; usually is_multi_level too)
--
-- NULLABLE = unspecified: existing units simply won't match a floor filter
-- until the landlord sets it in the unit editor. No misleading default.
ALTER TABLE units
  ADD COLUMN IF NOT EXISTS floor_level text
  CONSTRAINT units_floor_level_check
  CHECK (floor_level IS NULL OR floor_level IN ('ground_floor','upper_floor','basement','multi_floor'));
