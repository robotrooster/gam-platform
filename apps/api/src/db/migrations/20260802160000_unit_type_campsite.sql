-- S577 — campsite unit type (Nic).
--
-- WHY: tent / primitive campground site (no hookups), distinct from an RV site.
-- Bookable like an RV spot. Rounds out the outdoor-hospitality classification.
-- (Cabins are deliberately NOT a type — a cabin is a dwelling; landlords name
-- it via the per-property subtype system.)
--
-- Mirrors the S538 hotel_room / S577 parking-boatslip-landlot precedent: the
-- same FOUR CHECK constraints pin the unit-type list; all extended to match
-- shared UNIT_TYPES (now 11 types). No backfill.

ALTER TABLE units DROP CONSTRAINT units_unit_type_check;
ALTER TABLE units ADD CONSTRAINT units_unit_type_check
  CHECK (unit_type = ANY (ARRAY['apartment','single_family','rv_spot','campsite','mobile_home','hotel_room','storage','parking','boat_slip','land_lot','commercial']::text[]));

ALTER TABLE property_unit_subtypes DROP CONSTRAINT property_unit_subtypes_unit_type_check;
ALTER TABLE property_unit_subtypes ADD CONSTRAINT property_unit_subtypes_unit_type_check
  CHECK (unit_type = ANY (ARRAY['apartment','single_family','rv_spot','campsite','mobile_home','hotel_room','storage','parking','boat_slip','land_lot','commercial']::text[]));

ALTER TABLE property_unit_type_late_fees DROP CONSTRAINT property_unit_type_late_fees_unit_type_check;
ALTER TABLE property_unit_type_late_fees ADD CONSTRAINT property_unit_type_late_fees_unit_type_check
  CHECK (unit_type = ANY (ARRAY['apartment','single_family','rv_spot','campsite','mobile_home','hotel_room','storage','parking','boat_slip','land_lot','commercial']::text[]));

ALTER TABLE lease_templates DROP CONSTRAINT lease_templates_unit_type_check;
ALTER TABLE lease_templates ADD CONSTRAINT lease_templates_unit_type_check
  CHECK (unit_type IS NULL OR unit_type = ANY (ARRAY['apartment','single_family','rv_spot','campsite','mobile_home','hotel_room','storage','parking','boat_slip','land_lot','commercial']::text[]));
