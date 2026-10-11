-- 10/4 (decisions #38): the schedule's history says what an early check-out did
-- with the money — "Left early — $90.00 back to Visa ••4242, $190.00 cash
-- handed back", "Left early — charged only the 3 nights stayed ($270.00)".
--
-- A new event type, 'money_settled' (shared UNIT_BOOKING_EVENT_TYPES). It is
-- its own type, not a 'dates_changed' event, because the schedule reads the
-- latest 'dates_changed' event to find the day an early check-out replaced
-- (routes/units bookedDayBeforeEarlyCheckOut) and a money line must never hide it.
--
-- Expand-only: the CHECK gains one value; every existing row still passes. No
-- backfill needed.
ALTER TABLE unit_booking_events DROP CONSTRAINT IF EXISTS unit_booking_events_type_check;
ALTER TABLE unit_booking_events ADD CONSTRAINT unit_booking_events_type_check
  CHECK (event_type IN ('created', 'moved', 'dates_changed', 'status_changed', 'cancelled', 'money_settled'));
