-- S92 / DEFERRED Item 11: Master Schedule finish (product call: BUILD).
--
-- Three drift sources reconciled in one migration:
--
-- 1. units missing 3 cols that PATCH /units/:id/type writes:
--    monthly_rate, min_stay_nights, max_stay_nights. Pre-S92 the UPDATE
--    threw "column does not exist" on first hit.
--
-- 2. unit_bookings missing 6 cols that POST /units/:id/bookings writes:
--    landlord_id, lease_type, nightly_rate, weekly_rate, platform_fee,
--    source. Same throw at runtime.
--
-- 3. Vocabulary drift between schema, route, and frontend:
--    - schema unit_bookings.booking_type CHECK: nightly | weekly | lease_hold
--    - route INSERTs `lease_type` (column doesn't exist) with values
--      nightly | weekly | month_to_month | long_term
--    - frontend SchedulePage SCHEDULE_BOOKING_TYPES: nightly | weekly |
--      month_to_month | long_term
--    Schema was the odd one out. Route+frontend vocabulary wins; we
--    drop booking_type and replace with lease_type spanning all five
--    semantic values (the four route values plus 'lease_hold' which
--    the schema CHECK already encoded — kept so a future "block this
--    spot for an existing tenant's lease" use case has somewhere to go).
--
-- unit_bookings is empty in dev (zero rows) — safe to drop+add the
-- type column cleanly. landlord_id can be NOT NULL from day one.
--
-- units.lease_types_allowed default also flipped from ['fixed_term'] (a
-- vocabulary not used anywhere else) to '{}' so new units start with
-- no allowed types until the landlord configures /:id/type. The PATCH
-- route writes lease_types_allowed explicitly via LEASE_TYPE_MATRIX
-- keyed on unit_type (units.ts:184-189).

-- ── units: 3 missing cols ────────────────────────────────────
ALTER TABLE units ADD COLUMN monthly_rate    numeric(10,2);
ALTER TABLE units ADD COLUMN min_stay_nights integer;
ALTER TABLE units ADD COLUMN max_stay_nights integer;

ALTER TABLE units ALTER COLUMN lease_types_allowed SET DEFAULT '{}'::text[];

-- ── unit_bookings: drop legacy booking_type, add 6 missing cols ──
ALTER TABLE unit_bookings DROP CONSTRAINT IF EXISTS unit_bookings_booking_type_check;
ALTER TABLE unit_bookings DROP COLUMN booking_type;

ALTER TABLE unit_bookings ADD COLUMN landlord_id  uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT;
ALTER TABLE unit_bookings ADD COLUMN lease_type   text NOT NULL;
ALTER TABLE unit_bookings ADD COLUMN nightly_rate numeric(10,2);
ALTER TABLE unit_bookings ADD COLUMN weekly_rate  numeric(10,2);
ALTER TABLE unit_bookings ADD COLUMN platform_fee numeric(10,2) NOT NULL DEFAULT 0;
ALTER TABLE unit_bookings ADD COLUMN source       text NOT NULL DEFAULT 'direct';

ALTER TABLE unit_bookings ADD CONSTRAINT unit_bookings_lease_type_check
  CHECK (lease_type = ANY (ARRAY['nightly','weekly','month_to_month','long_term','lease_hold']));

CREATE INDEX idx_unit_bookings_landlord_dates
  ON unit_bookings(landlord_id, check_in, check_out);
CREATE INDEX idx_unit_bookings_unit_dates
  ON unit_bookings(unit_id, check_in, check_out)
  WHERE status NOT IN ('cancelled','no_show');
