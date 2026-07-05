-- W-16 (S529): prevent duplicate unit numbers at the same property.
-- Unit numbers are type-prefixed at creation ("RV 02", "House 01",
-- "Storage 01"), so a plain (property_id, unit_number) uniqueness covers
-- Nic's "no duplicate numbers for the same unit type" intent and is
-- stricter: two units displaying the same number at one property is always
-- a bookkeeping hazard regardless of type. Case/whitespace-insensitive so
-- "apt 204" can't slip past "Apt 204".
--
-- No backfill needed: verified zero duplicates in existing data before
-- adding. The API converts violations of this index into a friendly 409
-- (routes/units.ts / properties.ts unit-create paths).
CREATE UNIQUE INDEX units_property_unit_number_uniq
  ON units (property_id, lower(btrim(unit_number)));
