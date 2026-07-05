-- Drop the retired S526 subtype_key pricing table (Nic OK'd 2026-07-03).
-- S527 replaced it with owner-defined property_unit_subtypes; its rows were
-- converted (with the default→override field merge applied) by
-- 20260703170000_property_unit_subtypes.sql. No reader remains — the
-- /unit-type-pricing routes and both frontend consumers were removed in S527.
-- No backfill needed; data already migrated.
DROP TABLE IF EXISTS property_unit_type_pricing;
