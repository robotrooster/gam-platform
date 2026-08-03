-- S577 — parking, boat_slip, land_lot unit types (Nic).
--
-- WHY: "accommodate any space people rent to other people." Three physical
-- space types were missing from the classification:
--   * parking   — vehicle/parking space, split OUT of 'storage' (self-storage
--                 stays 'storage'). Short-stay-locked like storage: rented by
--                 the month, never booked nightly.
--   * boat_slip — wet slips / moorings / dock space at a marina or pier; an
--                 aquatic RV spot (bookable at every stay length).
--   * land_lot  — raw land / a leased lot beyond the mobile-home lot-rent case
--                 (leased acreage, vendor pad); monthly/long-term.
-- Short-term / vacation rentals are deliberately NOT a unit type — they remain
-- a short-stay BOOKING on any existing unit (Nic S577).
--
-- Mirrors the S538 hotel_room precedent: the same FOUR CHECK constraints pin
-- the unit-type list; all extended in step to match shared UNIT_TYPES.
-- (property_unit_type_pricing was superseded by property_unit_subtypes in S527
-- and no longer exists — not touched.)
--
-- Pricing: new types default to the 5% STR side on short stays
-- (NIGHTS_AGGREGATION_UNIT_TYPES stays rv_spot-only). boat_slip as an RV-style
-- $2/30-night type is a separate Nic pricing decision, not made here.
--
-- No backfill: no existing rows change type.

ALTER TABLE units DROP CONSTRAINT units_unit_type_check;
ALTER TABLE units ADD CONSTRAINT units_unit_type_check
  CHECK (unit_type = ANY (ARRAY['apartment','single_family','rv_spot','mobile_home','hotel_room','storage','parking','boat_slip','land_lot','commercial']::text[]));

ALTER TABLE property_unit_subtypes DROP CONSTRAINT property_unit_subtypes_unit_type_check;
ALTER TABLE property_unit_subtypes ADD CONSTRAINT property_unit_subtypes_unit_type_check
  CHECK (unit_type = ANY (ARRAY['apartment','single_family','rv_spot','mobile_home','hotel_room','storage','parking','boat_slip','land_lot','commercial']::text[]));

ALTER TABLE property_unit_type_late_fees DROP CONSTRAINT property_unit_type_late_fees_unit_type_check;
ALTER TABLE property_unit_type_late_fees ADD CONSTRAINT property_unit_type_late_fees_unit_type_check
  CHECK (unit_type = ANY (ARRAY['apartment','single_family','rv_spot','mobile_home','hotel_room','storage','parking','boat_slip','land_lot','commercial']::text[]));

ALTER TABLE lease_templates DROP CONSTRAINT lease_templates_unit_type_check;
ALTER TABLE lease_templates ADD CONSTRAINT lease_templates_unit_type_check
  CHECK (unit_type IS NULL OR unit_type = ANY (ARRAY['apartment','single_family','rv_spot','mobile_home','hotel_room','storage','parking','boat_slip','land_lot','commercial']::text[]));
