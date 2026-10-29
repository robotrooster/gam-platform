-- 10/20 (Nic) — A FINAL UTILITY BILL RAISED AT THE REGISTER, WITH THE PAYER
-- STANDING THERE.
--
--   "I don't want it to generate a bill."
--
--   "desk picks the customer and gam should know the site from the reservation.
--    no reason for the front counter to pick a space too"
--
-- WHAT HAPPENS TODAY. A move-out read taken anywhere in GAM bills, invoices and
-- emails the departing payer in the same breath: "pay it from your portal, or it
-- settles from your deposit". That is the right answer for a read taken on a
-- walk-round at month end and the wrong one with the payer at the counter
-- waiting to settle up — it creates a SECOND place to pay one bill, and the
-- second place is the one with nobody standing at it.
--
-- So the counter raises the bill and nothing else: no invoice, no email, no
-- deposit talk. The ticket IS the bill, and paying it closes the bill out. If it
-- is not paid — they walk off, or the desk clears the cart — the bill stays owed
-- and falls back to the ordinary route (their invoice, or an emailed link),
-- because the power was genuinely used and nothing in GAM is written off by not
-- being collected at a counter. The READING always stands either way.
--
-- WHY THIS IS NOT A NEW BOOK. utility_pay_link_settlements (20261022100000) is
-- already "the one book for utility money collected through the POS": one row
-- per utility line, with the bill it closes out, and two partial unique indexes
-- that make a second collection of one bill impossible rather than unlikely.
-- A bill collected at the till is the same fact arriving through the same till,
-- so it goes in the same book. Its own migration says why a second table would
-- be wrong: "the first report that has to add two tables together is the day the
-- number stops being trustworthy."
--
-- The only thing that was wired into the table shape was the DOOR: pay_link_id
-- was NOT NULL, because every row had come from a link. A row raised at the
-- counter has no link and never will — nothing is emailed — so the column goes
-- nullable and one new boolean says which door it came through. Both indexes
-- key on utility_bill_id and so cover both doors as they stand: one OPEN ask per
-- bill (a bill held on a counter ticket cannot also go out on a link, and the
-- Pay Links list stops offering it), and one SETTLEMENT per bill EVER.
--
-- EXPAND ONLY. One column dropped from NOT NULL, two columns added, two checks
-- added, nothing rewritten and no backfill: every existing row is a pay-link row
-- and reads exactly as it did. Re-runnable.

ALTER TABLE utility_pay_link_settlements
  ALTER COLUMN pay_link_id DROP NOT NULL;

ALTER TABLE utility_pay_link_settlements
  -- Which door. Not derived from "pay_link_id IS NULL", because a nullable
  -- column reads as "not known yet" everywhere else in this schema and this is
  -- a deliberate answer: this money was asked for at a counter.
  ADD COLUMN IF NOT EXISTS raised_at_counter boolean NOT NULL DEFAULT false,
  -- The closing read the counter took, which is the whole reason the bill
  -- exists. Kept on the money row so the figure can be traced back to the face
  -- of the meter without going through the bill — the bill is deleted by
  -- nobody, but a bill that is voided and re-raised would lose the thread.
  ADD COLUMN IF NOT EXISTS meter_reading_id uuid REFERENCES utility_meter_readings(id);

-- A row came through exactly one door. A counter row with a link on it would be
-- a bill asked for in two places at once, which is the one thing the indexes
-- below exist to prevent.
ALTER TABLE utility_pay_link_settlements
  DROP CONSTRAINT IF EXISTS upls_one_door;
ALTER TABLE utility_pay_link_settlements
  ADD CONSTRAINT upls_one_door
    CHECK ((pay_link_id IS NOT NULL) <> raised_at_counter);

-- A counter row is ALWAYS a bill being closed out. The bill-less shape — money
-- rung up by hand for somebody's power that no bill was ever cut for (the
-- Andres shape) — is a catalog line a clerk tapped, and that line records
-- itself off pos_items.recovers_utility like any other sale. A counter row with
-- no bill would be the same dollars counted a second time.
ALTER TABLE utility_pay_link_settlements
  DROP CONSTRAINT IF EXISTS upls_counter_row_names_its_bill;
ALTER TABLE utility_pay_link_settlements
  ADD CONSTRAINT upls_counter_row_names_its_bill
    CHECK (NOT raised_at_counter OR utility_bill_id IS NOT NULL);

COMMENT ON COLUMN utility_pay_link_settlements.pay_link_id IS
  'The emailed link this utility line went out on, or NULL when the line was '
  'raised at the register with the payer standing there (raised_at_counter). '
  'Those are the only two doors, and upls_one_door holds a row to one of them.';

COMMENT ON COLUMN utility_pay_link_settlements.raised_at_counter IS
  '10/20 (Nic): TRUE when the desk took the closing read and put the bill on the '
  'ticket — "I don''t want it to generate a bill". Such a row is on no invoice '
  'and nothing was emailed for it while it is open; paying the ticket settles it, '
  'and cancelling it hands the bill back to the ordinary route.';

COMMENT ON COLUMN utility_pay_link_settlements.meter_reading_id IS
  'The closing read this bill was raised from, when it was raised at a counter. '
  'The read always stands, whether or not the bill is ever collected.';

-- How the open counter asks are found when a register comes back to them: one
-- property's, oldest first. Partial, because the open ones are the only rows
-- anybody looks for by hand.
CREATE INDEX IF NOT EXISTS upls_open_at_counter
  ON utility_pay_link_settlements (property_id, created_at)
  WHERE status = 'open' AND raised_at_counter;
