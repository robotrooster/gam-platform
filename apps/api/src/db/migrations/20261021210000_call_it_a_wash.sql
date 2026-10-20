-- 10/20 (Nic) — CALL IT A WASH.
--
--   "So what we do when people leave early is we'll usually call it a wash. We
--    don't refund the money, but we also don't bill them a final electric bill.
--    We need to still get the meter reads to close it out and count that as, if
--    we're keeping track of electric that's not billed back, we need to count
--    that there, but it doesn't need to get attached to anything. I would like
--    to call it a wash, though. I would like to keep track of money that wasn't
--    refunded versus electric that should have been billed that wasn't charged
--    to see how close we actually get to evening out. You know, because people
--    leave at various times and we try to be generous with it, but I want to
--    make sure that it's somewhat fair."
--
-- Two sides of one departure, and the whole point is seeing them SIDE BY SIDE.
-- RV 10 (Victor Cardoza) and RV 11 (Nemesio Rivera) at Mountain View are the
-- departures that prompted this: both paid $589 for 10/04–11/04, both pulled
-- out 10/18 at 14 nights, neither was refunded, and neither has a utility bill
-- to their name. Today that is two invisible facts. GAM kept $589-worth of
-- unused nights twice over and ate two closing reads, and nothing anywhere
-- says so, so "how close do we actually get to evening out" has no answer.
--
-- A departure is a WASH when BOTH hold: they left before the day they had paid
-- or booked through, AND no money went back. Then the final utility stub bills
-- NOBODY — no invoice, no debt, no late fee, nothing on their account, because
-- "it doesn't need to get attached to anything" — but it IS recorded, with the
-- reason, against the departure, beside the money that stayed.
--
-- ─── WHY THE OWNER-USE TABLE BECOMES THE ONE BOOK ──────────────────────────
--
-- utility_owner_use_absorptions (S609) was built to answer exactly this
-- question for a different reason. Its own comment says it is "the provable
-- record that it was held back rather than passed through". Absorbing a
-- departing guest's last kilowatts is the same kind of fact as absorbing an
-- owner-occupied unit's share: utility cost that GAM billed to nobody. A
-- second table for the same idea would mean every report that wants "what did
-- we not get back" has to remember to add two numbers, and the first one
-- somebody forgets is the day the number stops being trustworthy.
--
-- So it is renamed utility_absorbed_charges and given a `reason`, and every
-- name it carried is renamed with it — indexes, checks, foreign keys, primary
-- key, audit trigger — so nothing is left pointing at an idea the table no
-- longer has. It holds zero rows in production, which is why this is cheap.
--
-- ─── THE KEY, WHICH IS THE WHOLE BALLGAME ──────────────────────────────────
--
-- The old key was UNIQUE (meter_id, unit_id, billing_cycle_month). For owner
-- use that is right: a unit takes one share of one meter's pool per month. For
-- departures it is WRONG and quietly destructive — two guests leaving RV 11 in
-- one October is a routine season week at an RV park, and that key lets the
-- second one's power silently overwrite the first one's. The number Nic wants
-- to trust would be short by one departure and nothing would say so.
--
-- The identity of an absorbed charge is not the month. It is WHOSE it was:
--
--   * a cycle-shaped absorption (owner use, a vacant space, power in a nightly
--     rate) is one per meter, space, month and reason;
--   * a departure-shaped absorption is one per DEPARTURE per meter, whatever
--     month the closing read happens to land in — because a departure has
--     exactly one final stub per meter, and if the same stub could be written
--     once in October and again in November the total would double-count.
--
-- Two partial unique indexes say precisely that, split on whether the row
-- names a departure. A third repeats the owner-use rule in the three-column
-- shape the live RUBS engine's ON CONFLICT still names; see the deploy note.
--
-- ─── WHY THE MONEY GETS ITS OWN TABLE ──────────────────────────────────────
--
-- early_departure_washes, one row per departure. Not columns on the absorption
-- rows, for three reasons that are all the same reason:
--
--   1. The money is ONE fact per departure; the power is N facts, one per
--      meter. A site with an electric submeter and a water submeter absorbs two
--      stubs against one $589. Carried on the absorption rows, that $589 would
--      appear twice the moment a property has two meters, and "money kept"
--      would silently inflate with the meter count.
--   2. They arrive in either order and at different desks. The money is known
--      the minute the desk answers the check-out question; the power is not
--      known until somebody walks out and reads the meter, which may be days
--      later or may already have happened. A wash whose read has not landed yet
--      must still be a row — there is nothing for it to be a column on.
--   3. One row per departure is what makes the pairing readable: the report
--      Nic asked for is a join on wash_id, not a correlated guess at which
--      absorption lines belong to the same person leaving.
--
-- The table can only hold an early departure: CHECK (departed_on <
-- paid_through). Somebody who left on their booked day kept nothing and there
-- is nothing to wash, so there is no row for them to be mistaken for.
--
-- A refund of ANY size means no wash and the stub bills normally. A row whose
-- refund came later is not deleted — GAM never erases — it is stamped
-- unwound_at and stops counting, so the book still shows that a wash was
-- recorded and then undone.
--
-- ─── AND WHY THE HOLD GETS ITS OWN TABLE ───────────────────────────────────
--
-- utility_wash_holds, shaped after suspended_utility_charges (S629) because it
-- is the same manoeuvre: a share parked, reported to the caller as NOT billed,
-- waiting on an answer. The closing read can arrive before the money question
-- is answered — or while it waits on somebody with "Issue refunds" — and
-- billing the stub then means reversing a charge the guest may already have
-- read in an email. So it waits.
--
-- It is NOT parked in suspended_utility_charges itself, tempting as that is.
-- That table's nightly sweep (expireHeldChargesAfterOnboarding) cancels every
-- open hold once a property's onboarding window closes, with the reason
-- "resident left before signing". A departing guest's stub would be swept away
-- by a job that was never told about it, carrying a reason that is not true.
-- A hold is also not an absorption and must never be counted as one, which is
-- the other half of why it is its own table rather than a flag on the book.
--
-- ─── EXPAND ONLY, AND A DEPLOY NOTE THAT MATTERS ───────────────────────────
--
-- Idempotent throughout (IF NOT EXISTS / IF EXISTS, every rename guarded), and
-- proved by applying the file twice to a scratch database.
--
-- No backfill: utility_absorbed_charges holds no rows, so `reason`'s default
-- fills nothing, and it is the right answer for every row the live RUBS engine
-- writes next.
--
-- NOT SAFE AHEAD OF ITS CODE, unlike most GAM migrations. Replacing the
-- three-column unique index is the one thing here that cannot be made
-- backward-compatible: services/utilityBilling.ts writes owner-use absorptions
-- with `ON CONFLICT (meter_id, unit_id, billing_cycle_month) DO UPDATE`, and
-- Postgres will only infer a TOTAL index on exactly those columns — which is
-- the very index that forbids two departures in a month. Those two statements
-- need ` WHERE reason = 'owner_use'` added to their conflict target (verified
-- against this file on a scratch database, through the compatibility view
-- below as well as against the table), and ledgerSourceFacts.test.ts needs the
-- table's new name in AUDITED_MONEY_TABLES. Apply this with that change, not
-- before it.
--
-- The compatibility view keeps every READER working across the deploy — the
-- recovery report (routes/utility.ts) and the suites that select from the old
-- name need no edit at all — and it deliberately shows only owner-use rows, so
-- the recovery report's "owner occupied" column cannot start quietly swallowing
-- washes. Safe drop once nothing names it: DROP VIEW utility_owner_use_absorptions.
--
-- Safe drop for the rest: rename utility_absorbed_charges back, then
-- DROP TABLE utility_wash_holds, early_departure_washes.

-- ─── 1. The owner-use ledger becomes the one book for absorbed utility ──────

DO $$
BEGIN
  IF to_regclass('public.utility_owner_use_absorptions') IS NOT NULL
     AND to_regclass('public.utility_absorbed_charges') IS NULL THEN
    EXECUTE 'ALTER TABLE utility_owner_use_absorptions RENAME TO utility_absorbed_charges';
  END IF;
END $$;

-- A table rename leaves every other name behind, so each one is moved by hand.
DO $$
DECLARE
  old_name text;
  new_name text;
  pairs text[] := ARRAY[
    'utility_owner_use_absorptions_pkey',             'utility_absorbed_charges_pkey',
    'utility_owner_use_absorptions_amount_check',     'utility_absorbed_charges_amount_check',
    'utility_owner_use_absorptions_meter_id_fkey',    'utility_absorbed_charges_meter_id_fkey',
    'utility_owner_use_absorptions_unit_id_fkey',     'utility_absorbed_charges_unit_id_fkey',
    'utility_owner_use_absorptions_landlord_id_fkey', 'utility_absorbed_charges_landlord_id_fkey'
  ];
  i int;
BEGIN
  IF to_regclass('public.utility_absorbed_charges') IS NULL THEN RETURN; END IF;
  FOR i IN 1 .. array_length(pairs, 1) BY 2 LOOP
    old_name := pairs[i];
    new_name := pairs[i + 1];
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.utility_absorbed_charges'::regclass AND conname = old_name)
       AND NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.utility_absorbed_charges'::regclass AND conname = new_name) THEN
      EXECUTE format('ALTER TABLE utility_absorbed_charges RENAME CONSTRAINT %I TO %I', old_name, new_name);
    END IF;
  END LOOP;

  -- The reporting index keeps its shape and only its name changes.
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_owner_use_absorption_landlord_cycle')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_utility_absorbed_charge_landlord_cycle') THEN
    EXECUTE 'ALTER INDEX idx_owner_use_absorption_landlord_cycle RENAME TO idx_utility_absorbed_charge_landlord_cycle';
  END IF;

  -- The change journal: same trigger, named for the table it is now on.
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgrelid = 'public.utility_absorbed_charges'::regclass
                AND tgname = 'audit_utility_owner_use_absorptions')
     AND NOT EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgrelid = 'public.utility_absorbed_charges'::regclass
                AND tgname = 'audit_utility_absorbed_charges') THEN
    EXECUTE 'ALTER TRIGGER audit_utility_owner_use_absorptions ON utility_absorbed_charges '
            'RENAME TO audit_utility_absorbed_charges';
  END IF;
END $$;

-- ─── 2. The money side: one row per departure ───────────────────────────────

CREATE TABLE IF NOT EXISTS early_departure_washes (
  id                   uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  landlord_id          uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  property_id          uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  unit_id              uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  -- A guest with no tenant record of their own leaves this empty.
  tenant_id            uuid REFERENCES tenants(id) ON DELETE SET NULL,
  -- The departure. When a stay has one, the BOOKING is the departure — a long
  -- stay on a lease is one departure, not two, and keying it twice is how a
  -- double-count starts. A lease on its own is an ordinary move-out.
  lease_id             uuid REFERENCES leases(id) ON DELETE SET NULL,
  booking_id           uuid REFERENCES unit_bookings(id) ON DELETE SET NULL,
  -- The check-out window's money answer this was read from, when there was one.
  checkout_decision_id uuid REFERENCES stay_checkout_decisions(id) ON DELETE SET NULL,
  departed_on          date NOT NULL,
  paid_through         date NOT NULL,
  -- The unused money that stayed with the landlord. This is the left-hand
  -- column of Nic's comparison.
  amount_kept          numeric(12,2) NOT NULL,
  -- Any refund at all, full or partial, and it is no longer a wash.
  refund_given         boolean NOT NULL DEFAULT false,
  refund_amount        numeric(12,2) NOT NULL DEFAULT 0,
  -- A check-out undone, or a refund issued after the fact. The row stays and
  -- stops counting; GAM never erases.
  unwound_at           timestamptz,
  unwound_reason       text,
  recorded_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT early_departure_washes_departure_check
    CHECK (lease_id IS NOT NULL OR booking_id IS NOT NULL),
  CONSTRAINT early_departure_washes_money_check
    CHECK (amount_kept >= 0 AND refund_amount >= 0),
  -- Only an EARLY departure belongs here. Somebody who left on the day they
  -- booked through kept nothing, so there is no row of theirs to miscount.
  CONSTRAINT early_departure_washes_left_early_check
    CHECK (departed_on < paid_through),
  CONSTRAINT early_departure_washes_refund_shape
    CHECK ((refund_amount > 0) = refund_given),
  CONSTRAINT early_departure_washes_unwound_shape
    CHECK ((unwound_at IS NULL) = (unwound_reason IS NULL))
);

-- One wash per departure, and two departures on one site in one month are two
-- departures. A stay is keyed by its booking even when it had a lease, so the
-- same departure cannot be written once as a stay and again as a move-out.
CREATE UNIQUE INDEX IF NOT EXISTS ux_early_departure_wash_per_booking
  ON early_departure_washes (booking_id) WHERE booking_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_early_departure_wash_per_lease
  ON early_departure_washes (lease_id) WHERE booking_id IS NULL AND lease_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_early_departure_wash_landlord_departed
  ON early_departure_washes (landlord_id, departed_on);
CREATE INDEX IF NOT EXISTS idx_early_departure_wash_property_departed
  ON early_departure_washes (property_id, departed_on);

COMMENT ON TABLE early_departure_washes IS
  '10/20 (Nic): the money side of a wash — "money that wasn''t refunded versus electric that should have been billed that wasn''t charged, to see how close we actually get to evening out." One row per early departure (a lease move-out or a stay check-out): the day they left, the day they had paid through, what stayed with the landlord and whether any refund went back. A refund of any size means it is not a wash and the final utility stub bills normally. The power side is utility_absorbed_charges rows pointing back at wash_id, one per meter, because a site with two submeters absorbs two stubs against one kept amount.';
COMMENT ON COLUMN early_departure_washes.unwound_at IS
  'The check-out was undone, or a refund was issued after the fact. The row is kept and stops counting toward money kept (GAM never erases); the absorbed stubs pointing at it are taken back off the book and become billable again.';

-- ─── 3. The absorption book learns WHY, and WHOSE ───────────────────────────

ALTER TABLE utility_absorbed_charges
  ADD COLUMN IF NOT EXISTS reason             text NOT NULL DEFAULT 'owner_use',
  ADD COLUMN IF NOT EXISTS wash_id            uuid REFERENCES early_departure_washes(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS lease_id           uuid REFERENCES leases(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS booking_id         uuid REFERENCES unit_bookings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tenant_id          uuid REFERENCES tenants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS departed_on        date,
  ADD COLUMN IF NOT EXISTS tax_amount         numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usage_amount       numeric(14,4),
  ADD COLUMN IF NOT EXISTS rate_per_unit      numeric(12,6),
  ADD COLUMN IF NOT EXISTS reading_start      numeric(14,4),
  ADD COLUMN IF NOT EXISTS reading_end        numeric(14,4),
  ADD COLUMN IF NOT EXISTS reading_start_date date,
  ADD COLUMN IF NOT EXISTS reading_end_date   date;

DO $$
BEGIN
  -- The reasons utility cost ends up billed to nobody. Mirrors
  -- ABSORBED_CHARGE_REASONS in services/earlyDepartureWash.ts (CLAUDE.md: one
  -- definition per value set).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.utility_absorbed_charges'::regclass
                    AND conname = 'utility_absorbed_charges_reason_check') THEN
    ALTER TABLE utility_absorbed_charges
      ADD CONSTRAINT utility_absorbed_charges_reason_check
      CHECK (reason IN ('owner_use', 'early_departure_wash', 'short_stay_in_rate', 'vacant'));
  END IF;

  -- A wash row names the departure it belongs to, always. The per-departure
  -- unique index below is only as good as this.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.utility_absorbed_charges'::regclass
                    AND conname = 'utility_absorbed_charges_wash_shape') THEN
    ALTER TABLE utility_absorbed_charges
      ADD CONSTRAINT utility_absorbed_charges_wash_shape
      CHECK ((reason = 'early_departure_wash') = (wash_id IS NOT NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.utility_absorbed_charges'::regclass
                    AND conname = 'utility_absorbed_charges_tax_check') THEN
    ALTER TABLE utility_absorbed_charges
      ADD CONSTRAINT utility_absorbed_charges_tax_check CHECK (tax_amount >= 0);
  END IF;
END $$;

-- The old key, which cannot tell two departures apart.
DROP INDEX IF EXISTS ux_owner_use_absorption_per_cycle;

-- A cycle-shaped absorption — owner use, a vacant space, power inside a
-- nightly rate — is one per meter, space, month and reason.
CREATE UNIQUE INDEX IF NOT EXISTS ux_utility_absorbed_charge_per_cycle
  ON utility_absorbed_charges (meter_id, unit_id, billing_cycle_month, reason)
  WHERE wash_id IS NULL;

-- A departure-shaped absorption is one per departure per meter, and NOT per
-- month: a departure has exactly one final stub on each meter, so letting the
-- month into the key would let the same stub be written twice and double the
-- only number this whole feature exists to produce.
CREATE UNIQUE INDEX IF NOT EXISTS ux_utility_absorbed_charge_per_departure
  ON utility_absorbed_charges (wash_id, meter_id)
  WHERE wash_id IS NOT NULL;

-- Redundant as a rule (the per-cycle index above already covers owner use) and
-- kept for one reason: it is the conflict target the live RUBS engine names.
-- Postgres only infers a partial index when the statement repeats the
-- predicate, so those two statements gain ` WHERE reason = 'owner_use'` and
-- nothing else.
CREATE UNIQUE INDEX IF NOT EXISTS ux_utility_absorbed_charge_owner_use_per_cycle
  ON utility_absorbed_charges (meter_id, unit_id, billing_cycle_month)
  WHERE reason = 'owner_use';

CREATE INDEX IF NOT EXISTS idx_utility_absorbed_charge_wash
  ON utility_absorbed_charges (wash_id) WHERE wash_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_utility_absorbed_charge_landlord_reason
  ON utility_absorbed_charges (landlord_id, reason, billing_cycle_month);

COMMENT ON TABLE utility_absorbed_charges IS
  '10/20 (Nic): the one book for utility cost GAM billed to NOBODY, whatever the reason — an owner-occupied unit''s share of a RUBS pool (S609, the original purpose), a departing guest''s final stub called a wash, power inside a nightly rate, a vacant space. "If we''re keeping track of electric that''s not billed back, we need to count that there, but it doesn''t need to get attached to anything." Was utility_owner_use_absorptions, generalized rather than joined by a second table, because the first report that forgets to add the two together is the day the number stops being trustworthy. A wash row points at its departure in early_departure_washes.';
COMMENT ON COLUMN utility_absorbed_charges.reason IS
  'Why this cost was billed to nobody: owner_use (an owner-occupied unit''s share), early_departure_wash (they left early, kept no refund, so GAM ate the final stub), short_stay_in_rate (a nightly guest whose power is in the rate), vacant. Single source: ABSORBED_CHARGE_REASONS in services/earlyDepartureWash.ts.';
COMMENT ON COLUMN utility_absorbed_charges.wash_id IS
  'The departure this stub belonged to (early_departure_washes). Set for exactly the early_departure_wash rows, and the thing the per-departure unique index keys on — one absorbed stub per departure per meter, however many months the reads straddle.';

-- A view, not a leftover table, so production keeps recording owner use across
-- the deploy and the recovery report needs no edit. It shows ONLY owner-use
-- rows on purpose: that report's "owner occupied" column must not start
-- quietly including washes, which are a column of their own.
CREATE OR REPLACE VIEW utility_owner_use_absorptions AS
  SELECT id, meter_id, unit_id, landlord_id, utility_type, billing_cycle_month,
         allocation_method, allocation_basis, charge_amount, base_fee_share,
         notes, reason, created_at, updated_at
    FROM utility_absorbed_charges
   WHERE reason = 'owner_use'
  WITH CASCADED CHECK OPTION;

COMMENT ON VIEW utility_owner_use_absorptions IS
  '10/20: the old name for utility_absorbed_charges, kept so the owner-use writers and readers work either side of the rename. Owner-use rows only. Drop it once nothing names it.';

-- ─── 4. A final stub parked until the money question is answered ────────────

CREATE TABLE IF NOT EXISTS utility_wash_holds (
  id                  uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  meter_id            uuid NOT NULL REFERENCES utility_meters(id) ON DELETE CASCADE,
  unit_id             uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  landlord_id         uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  -- The departure, as the billing gate knows it. The wash row may not exist
  -- yet — that is the entire reason this table is here.
  lease_id            uuid REFERENCES leases(id) ON DELETE SET NULL,
  booking_id          uuid REFERENCES unit_bookings(id) ON DELETE SET NULL,
  tenant_id           uuid REFERENCES tenants(id) ON DELETE SET NULL,
  departed_on         date NOT NULL,
  billing_cycle_month date NOT NULL,
  utility_type        text NOT NULL,
  usage_amount        numeric(14,4),
  allocation_method   text,
  allocation_basis    numeric(14,4),
  rate_per_unit       numeric(12,6),
  base_fee_share      numeric(12,2) NOT NULL DEFAULT 0,
  charge_amount       numeric(12,2) NOT NULL,
  tax_rate_pct        numeric(6,3),
  tax_amount          numeric(12,2),
  sewer_rate_per_unit numeric(12,6),
  reading_start       numeric(14,4),
  reading_end         numeric(14,4),
  reading_start_date  date,
  reading_end_date    date,
  notes               text,
  -- The answer came back "no refund": the hold became a line in the book.
  absorbed_at         timestamptz,
  absorbed_charge_id  uuid REFERENCES utility_absorbed_charges(id) ON DELETE SET NULL,
  -- The answer came back "a refund went out": the stub bills normally after all.
  released_at         timestamptz,
  released_reason     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT utility_wash_holds_amount_check CHECK (charge_amount >= 0),
  CONSTRAINT utility_wash_holds_departure_check
    CHECK (lease_id IS NOT NULL OR booking_id IS NOT NULL),
  CONSTRAINT utility_wash_holds_outcome_check
    CHECK (NOT (absorbed_at IS NOT NULL AND released_at IS NOT NULL)),
  CONSTRAINT utility_wash_holds_absorbed_shape
    CHECK ((absorbed_at IS NULL) = (absorbed_charge_id IS NULL)),
  CONSTRAINT utility_wash_holds_released_shape
    CHECK ((released_at IS NULL) = (released_reason IS NULL))
);

-- One OPEN hold per departure per meter and space. Closed ones stay for the
-- record, so the predicate is what keeps a re-run from parking a second copy.
CREATE UNIQUE INDEX IF NOT EXISTS ux_utility_wash_hold_open
  ON utility_wash_holds (meter_id, unit_id, COALESCE(booking_id, lease_id))
  WHERE absorbed_at IS NULL AND released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_utility_wash_hold_departure
  ON utility_wash_holds (COALESCE(booking_id, lease_id));
CREATE INDEX IF NOT EXISTS idx_utility_wash_hold_open_landlord
  ON utility_wash_holds (landlord_id, departed_on)
  WHERE absorbed_at IS NULL AND released_at IS NULL;

COMMENT ON TABLE utility_wash_holds IS
  '10/20 (Nic): a departing payer''s final utility stub, parked because the money question is not answered yet — the closing read came in first, or the clerk who checked them out could not answer it without "Issue refunds". Reported to the billing engine as NOT billed, the same as the invite hold it is shaped after (suspended_utility_charges, S629), because billing it and then learning it was a wash means reversing a charge the guest may already have seen. Its own table and not suspended_utility_charges: that table''s nightly sweep closes every open hold when a property''s onboarding window shuts, with a reason that would be untrue of somebody who drove away. A hold is not an absorption and is never counted as one.';

-- ─── 5. Every money table keeps its history (CLAUDE.md) ─────────────────────
--
-- Forward-only, and shaped so a re-run and a table another lane already gave a
-- trigger both come out the same. utility_absorbed_charges keeps the trigger it
-- had under its old name, renamed in step 1; these two are new.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['early_departure_washes', 'utility_wash_holds', 'utility_absorbed_charges'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_trigger
                        WHERE tgrelid = to_regclass('public.' || t) AND tgname = 'audit_' || t) THEN
      EXECUTE format(
        'CREATE TRIGGER %I AFTER DELETE OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
        'audit_' || t, t);
    END IF;
  END LOOP;
END $$;
