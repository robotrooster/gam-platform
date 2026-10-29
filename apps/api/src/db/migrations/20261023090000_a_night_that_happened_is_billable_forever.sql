-- 10/21 (Nic, DIRECTIVE) — A NIGHT THAT HAPPENED IS BILLABLE FOREVER.
--
--   "that's one of the reasons why I want the reservation locked at checkout
--    with no way to delete it. Because if, like, say I had 10 or 12 people go
--    in the month, and then the landlord goes to delete all of those out of the
--    schedule before the close of the month, then when it reads the schedule,
--    the landlord could be cheating us out of the subscription fee by deleting
--    the history. We need a way to have that no matter what changes they try to
--    do."
--
--   "let's do the migration you were talking about where it counts who's in the
--    spot each night. That way, you know, that way if people extend or leave
--    early, it's got an accurate count."
--
-- ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
--
-- Nightly and weekly nights are the one thing GAM bills in ARREARS (S650): the
-- aggregate is counted on the 1st for the month just ended, because nobody
-- knows a nightly park's total until the month is over. That count read the
-- reservations' own dates AT THE MOMENT THE BILL WAS CUT. Everything else about
-- a past stay was already locked — a checked-in or checked-out stay cannot be
-- cancelled or marked a no-show (routes/units stayHappenedRefusal), a
-- cancellation only exempts nights when it happened before arrival (S652, with
-- a trigger stamping cancelled_at so no call site can forget), and no route
-- deletes a reservation at all.
--
-- But EDITING THE DATES of a stay that already happened is deliberately allowed
-- (S548: it is how a monthly stay is shortened and what was paid past the new
-- end is banked). So SQL could not tell "they left early" from "pretend they
-- left early" — the same edit — and a landlord re-dating a month's stays on the
-- 30th lowered the nights GAM billed for. Ten rigs through one spot could be
-- re-dated down to a couple of nights.
--
-- ── THE RULE ────────────────────────────────────────────────────────────────
--
-- A night is stamped the morning after it happened, from what the schedule said
-- for that site that night, and the stamp is never rewritten. Then:
--
--   * leaving early stops FUTURE nights only — they are genuinely not on the
--     site tomorrow, which is Nic's "accurate count";
--   * extending adds nights as they happen;
--   * nothing done later can erase a night that already passed, whatever the
--     dates are edited to afterwards;
--   * a stay nobody closed out keeps stamping nights to its booked check-out,
--     which bills the landlord for nights nobody slept. Nic, told this
--     plainly: "that's going to be on their front desk people to stay on top of
--     the schedule correctly."
--
-- WHAT GAM BILLS DOES NOT CHANGE TODAY. The stamp applies the SAME status rule
-- the live count applied (services/billableUnits feeCountedNightsStatusSql): a
-- stay cancelled before arrival never stamps a night (its nights are all in the
-- future when it is cancelled), and one cancelled on or after arrival, or
-- marked a no-show, goes on stamping to its booked check-out exactly as the old
-- count charged it — "the site was held, it could not be sold to anybody else"
-- (S652), and a no-show bills (jobs/platformFeeAccrual has the test). Only
-- WHERE the number comes from changes: frozen rows instead of mutable dates.
--
-- ── WHY A ROW PER NIGHT AND NOT A MONTHLY COUNTER ───────────────────────────
--
-- A counter cannot answer "which site, which guest, which night" when a
-- landlord asks why their bill says what it says, and the one thing this is for
-- is being able to prove the count. A row per site per night is also what makes
-- the arithmetic re-runnable: the aggregate is COUNT(*), nothing derived.
--
-- Backfill: every night already past, from the reservations as they read now,
-- under the same status rule — so the first bill after this change is the bill
-- the old code would have cut. Five reservations exist in production today
-- (129 nights, of which the nights aggregate counts 7), so this is a handful of
-- rows; the bound is there for the parks that come later, not for this one.

CREATE TABLE IF NOT EXISTS unit_occupancy_nights (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id    uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  property_id    uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  unit_id        uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  booking_id     uuid NOT NULL REFERENCES unit_bookings(id) ON DELETE CASCADE,
  -- The date the guest slept there: a stay Oct 1 → Oct 3 is the nights Oct 1
  -- and Oct 2, which is check_out − check_in = 2, the same arithmetic the live
  -- count used.
  night          date NOT NULL,
  -- FROZEN AT STAMP TIME, because each of these decides whether the night is
  -- counted and each is editable afterwards. The count reads these, never the
  -- live row, so changing a reservation's kind or a site's type later cannot
  -- un-count a night that happened.
  lease_type     text NOT NULL,
  unit_type      text NOT NULL,
  -- What the reservation said that morning, for the landlord asking why.
  status_at_stamp text NOT NULL,
  stay_terms     text,
  stamped_at     timestamptz NOT NULL DEFAULT NOW(),
  created_at     timestamptz NOT NULL DEFAULT NOW(),
  updated_at     timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE unit_occupancy_nights IS
  '10/21 (Nic): one row per site per night, stamped the morning after and never rewritten — the nights GAM bills in arrears, so re-dating or deleting a reservation later cannot lower the count. services/occupancyNights.';
COMMENT ON COLUMN unit_occupancy_nights.lease_type IS
  'The reservation''s kind AS AT THE NIGHT. The count reads this, not the live row (editing it later must not un-count a night).';
COMMENT ON COLUMN unit_occupancy_nights.unit_type IS
  'The site''s type AS AT THE NIGHT, for the same reason — only some types aggregate nights (NIGHTS_AGGREGATION_UNIT_TYPES).';

-- One stamp per reservation per night. Two reservations on one site for one
-- night (which the schedule's own conflict check prevents) would count twice,
-- exactly as the live SUM over reservations did.
CREATE UNIQUE INDEX IF NOT EXISTS unit_occupancy_nights_once
  ON unit_occupancy_nights (booking_id, night);
-- The bill's own read: a property's nights in a month.
CREATE INDEX IF NOT EXISTS idx_unit_occupancy_nights_property_night
  ON unit_occupancy_nights (property_id, night);
CREATE INDEX IF NOT EXISTS idx_unit_occupancy_nights_unit_night
  ON unit_occupancy_nights (unit_id, night);

-- ── NOTHING ERASES A STAMP, AND NOTHING ERASES A RESERVATION ────────────────
--
-- On the limit of this guarantee, stated as plainly as S637 stated it for the
-- email log: a Postgres superuser can always ALTER TABLE ... DISABLE TRIGGER.
-- What this makes impossible is a deletion through the application, by any role
-- including super_admin and the owner. Removing one of these now takes a
-- deliberate, out-of-band act against the database itself.
CREATE OR REPLACE FUNCTION occupancy_night_block_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'unit_occupancy_nights row % is the record that site % was occupied on % — a night that happened cannot be deleted',
    OLD.id, OLD.unit_id, OLD.night;
END;
$$;

DROP TRIGGER IF EXISTS trg_occupancy_night_block_delete ON unit_occupancy_nights;
CREATE TRIGGER trg_occupancy_night_block_delete
  BEFORE DELETE ON unit_occupancy_nights
  FOR EACH ROW EXECUTE FUNCTION occupancy_night_block_delete();

-- The night and the site are frozen too: rewriting them would be a quieter
-- kind of deletion. (stamped_at/updated_at stay writable so a correction of a
-- non-counting column is possible at all.)
CREATE OR REPLACE FUNCTION occupancy_night_freeze()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.night       IS DISTINCT FROM OLD.night
  OR NEW.unit_id     IS DISTINCT FROM OLD.unit_id
  OR NEW.booking_id  IS DISTINCT FROM OLD.booking_id
  OR NEW.property_id IS DISTINCT FROM OLD.property_id
  OR NEW.lease_type  IS DISTINCT FROM OLD.lease_type
  OR NEW.unit_type   IS DISTINCT FROM OLD.unit_type THEN
    RAISE EXCEPTION
      'unit_occupancy_nights row % is what the schedule said that night — site, night, reservation and kind are frozen',
      OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_occupancy_night_freeze ON unit_occupancy_nights;
CREATE TRIGGER trg_occupancy_night_freeze
  BEFORE UPDATE ON unit_occupancy_nights
  FOR EACH ROW EXECUTE FUNCTION occupancy_night_freeze();

-- 10/21 (Nic): "no way to delete it". No route deletes a reservation today, so
-- this costs nothing and closes the door that is left: a hand-run DELETE, or a
-- future code path written without knowing. A reservation is cancelled, never
-- erased (GAM keeps everything).
CREATE OR REPLACE FUNCTION booking_block_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'unit_bookings row % cannot be deleted — a reservation is cancelled, never erased, and the nights it held are what GAM bills (10/21)',
    OLD.id;
END;
$$;

DROP TRIGGER IF EXISTS trg_booking_block_delete ON unit_bookings;
CREATE TRIGGER trg_booking_block_delete
  BEFORE DELETE ON unit_bookings
  FOR EACH ROW EXECUTE FUNCTION booking_block_delete();

-- The change journal, the house pattern: every UPDATE to a stamp is kept
-- forever (audit_row_changes is never pruned).
DROP TRIGGER IF EXISTS audit_unit_occupancy_nights ON unit_occupancy_nights;
CREATE TRIGGER audit_unit_occupancy_nights
  AFTER UPDATE OR DELETE ON unit_occupancy_nights
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- ── BACKFILL: every night already past ──────────────────────────────────────
--
-- The same status rule the live count applied, and the property's own calendar
-- for what "already past" means. Idempotent (the unique index), so a re-run
-- adds nothing.
INSERT INTO unit_occupancy_nights
  (landlord_id, property_id, unit_id, booking_id, night, lease_type, unit_type, status_at_stamp, stay_terms, stamped_at)
SELECT b.landlord_id, u.property_id, b.unit_id, b.id, d::date,
       b.lease_type, u.unit_type, b.status, b.stay_terms, NOW()
  FROM unit_bookings b
  JOIN units u ON u.id = b.unit_id
  JOIN properties p ON p.id = u.property_id
  CROSS JOIN LATERAL generate_series(
    b.check_in,
    LEAST(b.check_out - 1,
          ((NOW() AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date - 1)),
    INTERVAL '1 day') d
 WHERE NOT (b.status = 'cancelled' AND (b.cancelled_at IS NULL OR b.cancelled_at::date < b.check_in))
ON CONFLICT (booking_id, night) DO NOTHING;
