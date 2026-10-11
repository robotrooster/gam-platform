-- 10/3 (decisions #33): a stay is priced, taxed and split by the length it was
-- SOLD for, never by an early check-out.
--
-- Nic (10/2): "early checkout moves the check-out date." So check_out is the day
-- the guest actually left: the schedule frees the site that day, the closing
-- meter read is due that day and GAM's per-night count stops there. But the
-- money does not move with it (money plan §0.0: money already received is never
-- rewritten). Until now the length a stay was sold for could only be found in
-- the schedule's history (the latest 'dates_changed' event marked
-- early_check_out carries detail.booked_check_out), and every reader that
-- worked from the stored dates got it wrong after an early check-out:
--   - the register's "what is left to pay" (services/registerStay
--     reservationDue) dropped a 40-night untaxed stay to 12 nights and recorded
--     12% sales tax inside a price that never had any; a 30+ night stay stopped
--     being one its lease bills, and the counter asked for the whole price;
--   - GAM's short-stay revenue split (jobs/platformFeeAccrual,
--     services/platformFee) divided by the shortened length, so a stay counted
--     less than once across its months;
--   - the stay-deposit tax under "Money received" (services/incomeBasis)
--     rewrote a month that had already closed.
--
-- booked_check_out is the check-out the stay was SOLD for. It is set when a
-- reservation is made and on every deliberate change of its dates (the
-- schedule's Edit, a drag, an extension). An early check-out changes check_out
-- only; undoing it puts check_out back to this day. Readers take the later of
-- the two, with NULL read as check_out (services/registerStay soldCheckOutSql):
-- an early check-out can only make check_out earlier, and a path that
-- lengthens a stay without setting this column (the guest agent's extra
-- night) can only make it later.
--
-- Expand-only: one nullable column, no default, no constraint, so code that
-- does not know it (the running build, other insert paths) keeps working.
-- Backfill: check_out, except where the stay's latest 'dates_changed' event is
-- an early check-out still matching the stored dates — then that event's
-- booked_check_out (the same rule routes/units.ts bookedDayBeforeEarlyCheckOut
-- reads). Apply it right before the deploy of the code that writes the column:
-- the running build does not set it, so a stay whose dates that build changes
-- in between keeps the booked day this backfill gave it. (Production at the
-- time of writing: one booking, cancelled, and no early check-out events.)
ALTER TABLE unit_bookings ADD COLUMN IF NOT EXISTS booked_check_out date;

COMMENT ON COLUMN unit_bookings.booked_check_out IS
  '10/3 (decisions #33): the check-out the stay was sold for. Set on create and on every deliberate date change; an early check-out moves check_out only. Price, tax, deposit and revenue split read the later of this and check_out (empty = check_out): services/registerStay soldCheckOutSql.';

UPDATE unit_bookings b
   SET booked_check_out = COALESCE((
         SELECT CASE WHEN d.booked > b.check_out THEN d.booked END
           FROM (
             SELECT ev.detail,
                    CASE WHEN COALESCE(ev.detail->>'booked_check_out', ev.detail->'from'->>'check_out') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                         THEN substr(COALESCE(ev.detail->>'booked_check_out', ev.detail->'from'->>'check_out'), 1, 10)::date
                    END AS booked
               FROM unit_booking_events ev
              WHERE ev.booking_id = b.id AND ev.event_type = 'dates_changed'
              ORDER BY ev.created_at DESC, ev.id DESC
              LIMIT 1
           ) d
          WHERE d.detail->>'early_check_out' = 'true'
            AND d.detail->'to'->>'check_in'  = to_char(b.check_in,  'YYYY-MM-DD')
            AND d.detail->'to'->>'check_out' = to_char(b.check_out, 'YYYY-MM-DD')
       ), b.check_out)
 WHERE b.booked_check_out IS NULL;
