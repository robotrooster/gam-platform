-- S607 (Nic, DIRECTIVE): widen the allocation menu to what landlords across the
-- country actually use.
--
-- Nic: "we need a wider window scope for available options, and we narrow it on
-- our property setup to match Arizona law."
--
-- The platform offered five bases (occupancy, sq ft, bedrooms, equal split,
-- rented-only). Common US RUBS practice runs to roughly ten, and the four below
-- were unreachable — a landlord whose state or management agreement calls for
-- them simply could not run their park on GAM. None of this narrows anything:
-- every existing basis stays, and each new one is inert until selected.
--
--   fixture_count      — per plumbing fixture in the unit. An old and still
--                        widespread water basis, on the theory that fixtures
--                        proxy draw better than floor area does.
--   unit_type_weight   — a landlord-set weight per unit type, so a park can say
--                        a mobile home draws 1.5× an RV spot without inventing
--                        square footage for either.
--   weighted_occupancy — headcount with diminishing weight: the first occupant
--                        counts fully, each additional one counts less. Straight
--                        headcount overstates a large household, because two
--                        people do not run two showers at once.
--   hybrid             — a percentage blend of any two of the above (50% sq ft
--                        + 50% occupancy is the common third-party RUBS split).
--
-- WHERE THE CONFIGURATION LIVES: utility_meters.rubs_weights, one jsonb column
-- rather than four sparse typed columns, because each basis needs a differently
-- shaped config and only one is ever active on a meter:
--   unit_type_weight   {"mobile_home": 1.5, "rv_spot": 1.0}
--   weighted_occupancy {"first": 1.0, "additional": 0.5}
--   hybrid             {"primary": "sqft", "secondary": "occupant_count", "primaryPct": 50}
--
-- units.water_fixture_count is the only new per-unit data, nullable, and only
-- read by the fixture_count basis. A unit left NULL contributes 0 to that split
-- and is reported as skipped rather than silently absorbing a share.
--
-- No backfill: no meter uses these until a landlord picks one.

ALTER TABLE units
  ADD COLUMN IF NOT EXISTS water_fixture_count integer;

COMMENT ON COLUMN units.water_fixture_count IS
  'S607: plumbing fixture count, for the fixture_count RUBS allocation basis. NULL = not recorded; such a unit contributes 0 to a fixture split and is reported as skipped.';

ALTER TABLE utility_meters
  ADD COLUMN IF NOT EXISTS rubs_weights jsonb;

COMMENT ON COLUMN utility_meters.rubs_weights IS
  'S607: configuration for the allocation bases that need one. unit_type_weight: {unit_type: weight}. weighted_occupancy: {first, additional}. hybrid: {primary, secondary, primaryPct}. NULL elsewhere.';

ALTER TABLE utility_meters
  DROP CONSTRAINT IF EXISTS utility_meters_rubs_allocation_method_check;
ALTER TABLE utility_meters
  ADD CONSTRAINT utility_meters_rubs_allocation_method_check
  CHECK (rubs_allocation_method = ANY (ARRAY[
    'occupant_count'::text, 'sqft'::text, 'bedrooms'::text,
    'equal_split'::text, 'rented_spaces'::text,
    'fixture_count'::text, 'unit_type_weight'::text,
    'weighted_occupancy'::text, 'hybrid'::text]));
