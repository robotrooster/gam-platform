-- S605 (Nic, designed S604): RETIRE & REPLACE a unit.
--
-- A unit's number is LOCKED once it carries data (shipped S604) because nothing
-- snapshots `unit_number` — invoices, payments and bookings all join by
-- `unit_id` and render the CURRENT value, so a rename retroactively rewrites how
-- years of records display while executed lease PDFs keep the original and
-- silently disagree.
--
-- Nic's design: one physical space becomes TWO database records. Retire the old
-- unit, create its replacement under the new number, link them both ways.
-- "If data ever needs to be pulled you don't have to pinpoint when it changed
-- and what to look for before that."
--
-- ── Why this is enforced in the DB, not in route code ──────────────────────
-- The S604 handoff flagged the real risk: "audit every list query for
-- `retired_at IS NULL` — a missed filter is how a retired unit silently keeps
-- getting billed or booked." ~120 files touch `units`. Auditing all of them
-- perfectly, forever, against every future query, is not a thing that holds.
--
-- So retirement is enforced the same STRUCTURAL way `owner_use` was:
--
--   1. No new lease   — the existing lease trigger is widened to cover retired
--                       units, so all five lease-creation paths are covered at
--                       once (landlords.ts ×2, esign.ts, bookingLeaseDraft,
--                       applicationLeaseDraft).
--   2. No new booking — same idea, a trigger on unit_bookings.
--   3. Never billed   — FALLS OUT of (1). platformFeeAccrual counts distinct
--                       units with an ACTIVE LEASE (plus short-stay booking
--                       nights). A unit that cannot hold a lease or take a
--                       booking cannot be billed. Same anti-cheat shape as
--                       owner_use: no code change was needed there either.
--   4. Hidden from    — the only genuinely query-side concern, and it is a small
--      pickers          findable set (unit availability + the vacant-units agent
--                       tool), not 120 files.
--   5. Kept in reports — deliberately NOT filtered. History must survive and stay
--                       visible with a marker; that is the whole point.
--
-- Retirement requires the unit be free first (no active lease, no future
-- booking) — enforced in the retire endpoint, which is also why (3) holds.
--
-- No backfill: both columns are NULL for every existing unit, which reads as
-- "not retired" everywhere.

ALTER TABLE units
  ADD COLUMN IF NOT EXISTS retired_at             timestamptz,
  ADD COLUMN IF NOT EXISTS superseded_by_unit_id  uuid REFERENCES units(id),
  ADD COLUMN IF NOT EXISTS replaces_unit_id       uuid REFERENCES units(id);

COMMENT ON COLUMN units.retired_at IS
  'S605: when this unit was retired and replaced. NULL = live. A retired unit keeps all history but can never take a new lease or booking (enforced by trigger), so it is also never billed the per-unit platform fee.';
COMMENT ON COLUMN units.superseded_by_unit_id IS
  'S605: the replacement unit that took this one''s place under a new number.';
COMMENT ON COLUMN units.replaces_unit_id IS
  'S605: the retired unit this one replaced. Inverse of superseded_by_unit_id.';

-- Walking a retirement chain in either direction.
CREATE INDEX IF NOT EXISTS idx_units_superseded_by
  ON units (superseded_by_unit_id) WHERE superseded_by_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_units_replaces
  ON units (replaces_unit_id) WHERE replaces_unit_id IS NOT NULL;
-- Live units are the hot path for every picker.
CREATE INDEX IF NOT EXISTS idx_units_live_by_property
  ON units (property_id) WHERE retired_at IS NULL;

-- ── (1) No new lease on a retired unit ────────────────────────────────────
-- Widens the S604 owner_use guard rather than adding a parallel one, so there is
-- exactly ONE place that answers "may this unit hold a lease?". The old
-- single-purpose function is dropped in favour of the broader name.
CREATE OR REPLACE FUNCTION reject_lease_on_unavailable_unit() RETURNS trigger AS $$
DECLARE
  u_status  text;
  u_retired timestamptz;
  u_number  text;
BEGIN
  IF NEW.status NOT IN ('active', 'pending') THEN
    RETURN NEW;
  END IF;
  SELECT u.status, u.retired_at, u.unit_number
    INTO u_status, u_retired, u_number
    FROM units u WHERE u.id = NEW.unit_id;

  IF u_retired IS NOT NULL THEN
    RAISE EXCEPTION 'Unit % ("%") is retired and cannot hold a lease. Use its replacement unit instead.', NEW.unit_id, u_number
      USING ERRCODE = 'check_violation';
  END IF;
  IF u_status = 'owner_use' THEN
    RAISE EXCEPTION 'Unit % is marked owner-occupied and cannot hold a lease. Change its status first.', NEW.unit_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reject_lease_on_owner_use_unit ON leases;
DROP TRIGGER IF EXISTS trg_reject_lease_on_unavailable_unit ON leases;
CREATE TRIGGER trg_reject_lease_on_unavailable_unit
  BEFORE INSERT OR UPDATE OF unit_id, status ON leases
  FOR EACH ROW EXECUTE FUNCTION reject_lease_on_unavailable_unit();

DROP FUNCTION IF EXISTS reject_lease_on_owner_use_unit();

-- ── (2) No new booking on a retired unit ──────────────────────────────────
-- Bookings are created from the admin booking route, the public property-booking
-- flow and the availability/quote path, so this is guarded once here for the
-- same reason as leases. Cancelling or amending an existing booking on an
-- already-retired unit stays allowed — only NEW live bookings are refused.
CREATE OR REPLACE FUNCTION reject_booking_on_retired_unit() RETURNS trigger AS $$
DECLARE
  u_retired timestamptz;
  u_number  text;
BEGIN
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;
  SELECT u.retired_at, u.unit_number INTO u_retired, u_number
    FROM units u WHERE u.id = NEW.unit_id;
  IF u_retired IS NOT NULL THEN
    RAISE EXCEPTION 'Unit % ("%") is retired and cannot take a booking. Use its replacement unit instead.', NEW.unit_id, u_number
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reject_booking_on_retired_unit ON unit_bookings;
CREATE TRIGGER trg_reject_booking_on_retired_unit
  BEFORE INSERT OR UPDATE OF unit_id ON unit_bookings
  FOR EACH ROW EXECUTE FUNCTION reject_booking_on_retired_unit();
