-- 10/20 (Nic) — THE OLD SCHEDULE COMES IN, AND NOBODY IS EMAILED.
--
--   "I said import because I'm importing a fucking schedule for people that are
--    coming. I have other reservations that are texted to me. It's two
--    things... I do want a file importer. I do... The file importer gets all my
--    other reservations in there that were booked first. That's what I said. The
--    old system has all the ones that have already booked. The people that have
--    been texting me are the newer reservations. They don't get a spot if
--    there's no spot to put them. That's why the importer happens first, and
--    then the typed by hand ones come after."
--
-- and, on what entering one of them must NOT do:
--
--   "The import does not send the emails because one, you're going to be
--    sending emails to people that don't need them. And two, you have other
--    people that I don't want to put any new people in the old system... because
--    that's the thing is when we have to think about this from people migrating
--    where they may have already paid a deposit. They may have already gotten a
--    confirmation on a space number. Our system with compression and expansion
--    is going to kind of screw that up if they think they're locked to a
--    specific site already. So I don't want the import to do anything. I just
--    want it to import straight across."
--
-- A reservation that arrives this way is NOT a new reservation. It is a
-- reservation that has already been made, somewhere GAM was not, and three
-- things are already true of it that are never true of one taken at the desk:
--
--   1. THE GUEST HAS ALREADY BEEN TOLD. Nic told them himself, in the old
--      system, before any of this existed. GAM confirming them again is a
--      stranger emailing a guest about a reservation they made in March.
--   2. THE DEPOSIT MAY ALREADY BE PAID — to Nic, off-platform, in the old
--      system. The money never came through GAM and never will, so nothing here
--      may invent a GAM payment that did not happen; the reservation simply
--      knows its deposit is in, the same way a cash payment is written down
--      rather than processed (routes/payments record-manual).
--   3. THEY MAY HAVE BEEN PROMISED A SITE BY NUMBER. This is the dangerous one,
--      and Nic flagged it himself: GAM compresses and expands the board to fit
--      more rigs in (services/scheduleCompression), and a guest who was promised
--      site 14 and gets quietly compressed off it arrives to find somebody
--      else's fifth-wheel parked on it. `locked_to_unit` already stops that —
--      what was missing is WHY, so the board can say so.
--
-- These columns are what carries those three facts, plus the two things any
-- migration needs: who brought the row in, and enough identity to recognize the
-- SAME row if the same file is dropped in twice.
--
-- NO BACKFILL, and nothing here changes a single existing reservation. Every row
-- on the board today was born in GAM: migrated_at NULL says exactly that, and
-- told_outside_gam defaults false because GAM has never assumed a guest was told
-- by somebody else.
ALTER TABLE unit_bookings
  -- WHEN this reservation was brought in from somewhere else. NULL = born here.
  ADD COLUMN IF NOT EXISTS migrated_at timestamptz,
  ADD COLUMN IF NOT EXISTS migrated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  -- WHICH of Nic's two doors it came through: 'file' is the old system's own
  -- export (these booked FIRST and their sites are already promised, so they go
  -- in first and take their sites first), 'hand' is one typed in off a text
  -- thread afterwards, into whatever is left.
  ADD COLUMN IF NOT EXISTS migrated_door text,
  -- The identity of the row IN ITS SOURCE, so the same file dropped in twice
  -- does not put every guest on the board a second time. Built by one function
  -- (lib/reservationImportColumns migrationKey): the old system's own
  -- reservation number when the file carries one, else the guest and their dates
  -- at that park — which is the same reservation by any honest reading.
  ADD COLUMN IF NOT EXISTS migration_key text,
  -- THEY HAVE ALREADY BEEN TOLD. Set on the way in, and the confirmation
  -- endpoint reads it: GAM will not confirm a guest Nic already confirmed unless
  -- a person deliberately asks it to a second time (routes/bookings).
  ADD COLUMN IF NOT EXISTS told_outside_gam boolean NOT NULL DEFAULT false,
  -- WHY this stay cannot be moved off its site. NULL on a locked stay means
  -- somebody ticked the box on the reservation form, which is what every lock
  -- before today was. Deliberately NOT constrained against locked_to_unit:
  -- unlocking a stay is one UPDATE on one column elsewhere (routes/units), and
  -- a cross-column check here would turn that into a failure.
  ADD COLUMN IF NOT EXISTS lock_reason text,
  -- The deposit that was paid somewhere GAM was not. deposit_amount /
  -- deposit_paid_at say how much and when, the same as any other paid deposit;
  -- these two say it came in off-platform and how it was handed over, so no
  -- report ever reads it as money that moved through GAM.
  ADD COLUMN IF NOT EXISTS deposit_off_platform_method text,
  ADD COLUMN IF NOT EXISTS deposit_off_platform_ref text,
  -- The columns the file carried that GAM has no field for. Kept rather than
  -- dropped, exactly as the tenant and property importers keep theirs
  -- (lib/csvImportMappings mapWithExtra): "silently lost data" becomes "written
  -- down where somebody can look at it".
  ADD COLUMN IF NOT EXISTS import_extra_data jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.unit_bookings'::regclass
                    AND conname = 'unit_bookings_migrated_door_check') THEN
    ALTER TABLE unit_bookings
      ADD CONSTRAINT unit_bookings_migrated_door_check
      CHECK (migrated_door IS NULL OR migrated_door IN ('file', 'hand'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.unit_bookings'::regclass
                    AND conname = 'unit_bookings_lock_reason_check') THEN
    ALTER TABLE unit_bookings
      ADD CONSTRAINT unit_bookings_lock_reason_check
      CHECK (lock_reason IS NULL OR lock_reason IN ('promised_before_gam', 'promised_at_the_counter'));
  END IF;

  -- The ways money is handed over in person, the same four the desk records
  -- (@gam/shared MANUAL_PAYMENT_METHODS), plus 'other' — because this is a
  -- migration and the old system's receipt may not say which it was, and a
  -- deposit that is genuinely in must not be refused entry over that.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.unit_bookings'::regclass
                    AND conname = 'unit_bookings_deposit_off_platform_method_check') THEN
    ALTER TABLE unit_bookings
      ADD CONSTRAINT unit_bookings_deposit_off_platform_method_check
      CHECK (deposit_off_platform_method IS NULL
             OR deposit_off_platform_method IN ('cash', 'check', 'money_order', 'bank_deposit', 'other'));
  END IF;

  -- A migrated row names its door, and a door means a migrated row. Half of
  -- that pair is a row nobody can tell the story of.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.unit_bookings'::regclass
                    AND conname = 'unit_bookings_migration_shape') THEN
    ALTER TABLE unit_bookings
      ADD CONSTRAINT unit_bookings_migration_shape
      CHECK ((migrated_at IS NULL) = (migrated_door IS NULL));
  END IF;
END $$;

-- THE SAME FILE TWICE IS NOT TWO SEASONS. This is the whole defense against
-- the second drop of a 150-row season file doubling Nic's board: the commit
-- inserts ON CONFLICT DO NOTHING against this index and reports what it skipped.
-- Scoped to the landlord because the key itself is scoped to the property.
CREATE UNIQUE INDEX IF NOT EXISTS unit_bookings_migration_key_idx
  ON unit_bookings (landlord_id, migration_key)
  WHERE migration_key IS NOT NULL;

-- "Has this park's old schedule been brought in yet?" — asked of every
-- hand-typed reservation, to warn when the texted ones are being entered before
-- the file that is supposed to go in first.
CREATE INDEX IF NOT EXISTS unit_bookings_migrated_door_idx
  ON unit_bookings (unit_id, migrated_door)
  WHERE migrated_door IS NOT NULL;

COMMENT ON COLUMN unit_bookings.migrated_at IS
  'When this reservation was brought in from the old system or a text thread. NULL = taken in GAM.';
COMMENT ON COLUMN unit_bookings.migrated_door IS
  'file = the old system''s export (booked first, sites already promised); hand = typed in off a text thread afterwards.';
COMMENT ON COLUMN unit_bookings.migration_key IS
  'Identity of the row in its source, so re-importing the same file adds nobody twice. See lib/reservationImportColumns.';
COMMENT ON COLUMN unit_bookings.told_outside_gam IS
  'The guest was already told they have this reservation, outside GAM. The confirmation endpoint will not email them again without a deliberate second ask.';
COMMENT ON COLUMN unit_bookings.lock_reason IS
  'Why this stay cannot be moved off its site. promised_before_gam = the old system gave them this space number.';
COMMENT ON COLUMN unit_bookings.deposit_off_platform_method IS
  'How a deposit that never came through GAM was handed over. Set = this money moved somewhere GAM was not; GAM owes the landlord nothing for it.';

-- The review queue (csv_import_attempts) takes a fourth kind of file. Same
-- queue, same columns, same super-admin review as the tenant, property and
-- payment importers — a second queue for reservations would be a second place
-- to remember to look.
ALTER TABLE csv_import_attempts DROP CONSTRAINT IF EXISTS csv_import_attempts_import_type_check;
ALTER TABLE csv_import_attempts ADD CONSTRAINT csv_import_attempts_import_type_check
  CHECK (import_type IN ('tenant', 'property', 'payment', 'reservation'));
