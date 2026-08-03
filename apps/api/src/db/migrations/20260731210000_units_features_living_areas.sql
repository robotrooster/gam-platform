-- units.features + units.living_areas (S573, Nic) — inspection applicability.
--
-- WHY: the inspection master catalog is filtered to what a unit ACTUALLY HAS.
-- Beyond type/bed-bath/ownership/multi-level/floor, the landlord marks per-unit
-- features (back door, ceiling fans, dishwasher, fireplace, fenced yard, park
-- picnic table, …). Those gate which catalog items appear — nothing is ever
-- "N/A"; if the unit doesn't have it, it's absent.
--
-- features is JSONB (a { feature_key: true/false } map) ON PURPOSE: the product
-- evolves via feature requests, and new inspectable features must NOT require a
-- migration — just a new key in the shared UNIT_FEATURE_CATALOG. An absent key
-- falls back to the unit-type PRESET default (resolveUnitFeatures), so a unit
-- with zero configuration still inspects correctly.
--
-- living_areas: how many distinct living/family rooms the unit has (default 1);
-- the living-area checklist items repeat that many times, like bedrooms.
--
-- NO BACKFILL: features defaults '{}' (all keys fall back to presets),
-- living_areas defaults 1.
ALTER TABLE units
  ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS living_areas integer NOT NULL DEFAULT 1;
