-- S641 (Nic) — a building is part of a unit's identity.
--
--   "Letter suffixes are important for apartment complexes because you usually
--    have a property address, a building number. This is building one or
--    whatever, apartment G or A. So letter suffixes need to be able to be
--    duplicated — or even numbers, apartment 101 or 201, duplicated at the
--    property when assigned a separate building. That's one tier that we didn't
--    come up with yet."
--
-- He is right that it does not exist. Uniqueness was (property, unit_number),
-- so apartment 101 in Building 1 and 101 in Building 2 could not both be
-- entered — which is the ordinary shape of an apartment complex.
--
-- The number itself was never the problem: unit_number is text, so 14A and 14B
-- always stored fine. Only uniqueness was too narrow.

ALTER TABLE units
  ADD COLUMN IF NOT EXISTS building text;

-- Blank and NULL must not be two different buildings — a property with no
-- buildings would otherwise allow two "101"s, one with '' and one with NULL.
UPDATE units SET building = NULL WHERE building IS NOT NULL AND btrim(building) = '';

ALTER TABLE units DROP CONSTRAINT IF EXISTS units_building_not_blank;
ALTER TABLE units ADD CONSTRAINT units_building_not_blank
  CHECK (building IS NULL OR btrim(building) <> '');

-- ── Uniqueness is now property + building + number ─────────────────────────
--
-- COALESCE to '' so a property WITHOUT buildings keeps exactly the old
-- behaviour: one "101" per property. With buildings, each gets its own.
DROP INDEX IF EXISTS units_property_unit_number_uniq;
ALTER TABLE units DROP CONSTRAINT IF EXISTS units_property_id_unit_number_key;

CREATE UNIQUE INDEX IF NOT EXISTS units_property_building_number_uniq
  ON units (
    property_id,
    lower(btrim(COALESCE(building, ''))),
    lower(btrim(unit_number))
  );

CREATE INDEX IF NOT EXISTS idx_units_building
  ON units (property_id, building) WHERE building IS NOT NULL;

COMMENT ON COLUMN units.building IS
  'S641: the building within the property. NULL for properties that have none — most parks. Part of the uniqueness key, so Apt 101 can exist in Building 1 and Building 2.';
