-- S538 — hotel_room unit type (Nic).
--
-- WHY: small hotel/motel operators are a target market (Oak Park Motel
-- and RV is launch customer #1 and its motel rooms are currently typed
-- 'apartment' for lack of anything better). Their short-stay bookings
-- bill the 5% STR revenue fee like every non-RV type (S538 pricing:
-- the $2/30-night aggregation is rv_spot-ONLY), so no billing change —
-- this is purely the missing type. Rooms have no bedroom areas
-- (UNIT_TYPE_HAS_BEDROOMS=false); allow-list per LEASE_TYPE_MATRIX gets
-- nightly/weekly/month_to_month/long_term.
--
-- Four CHECK constraints pin the unit-type list — all extended in step.
-- No backfill: no rows change type here (retyping Oak Park's rooms is a
-- data decision for Nic, not a migration).

ALTER TABLE units DROP CONSTRAINT units_unit_type_check;
ALTER TABLE units ADD CONSTRAINT units_unit_type_check
  CHECK (unit_type = ANY (ARRAY['apartment','single_family','rv_spot','mobile_home','hotel_room','storage','commercial']::text[]));

ALTER TABLE property_unit_subtypes DROP CONSTRAINT property_unit_subtypes_unit_type_check;
ALTER TABLE property_unit_subtypes ADD CONSTRAINT property_unit_subtypes_unit_type_check
  CHECK (unit_type = ANY (ARRAY['apartment','single_family','rv_spot','mobile_home','hotel_room','storage','commercial']::text[]));

ALTER TABLE property_unit_type_late_fees DROP CONSTRAINT property_unit_type_late_fees_unit_type_check;
ALTER TABLE property_unit_type_late_fees ADD CONSTRAINT property_unit_type_late_fees_unit_type_check
  CHECK (unit_type = ANY (ARRAY['apartment','single_family','rv_spot','mobile_home','hotel_room','storage','commercial']::text[]));

ALTER TABLE lease_templates DROP CONSTRAINT lease_templates_unit_type_check;
ALTER TABLE lease_templates ADD CONSTRAINT lease_templates_unit_type_check
  CHECK (unit_type IS NULL OR unit_type = ANY (ARRAY['apartment','single_family','rv_spot','mobile_home','hotel_room','storage','commercial']::text[]));
