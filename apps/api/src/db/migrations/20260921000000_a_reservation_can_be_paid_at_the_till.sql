-- S652: the walk-in. A spot found on the schedule, paid for at the counter.
--
-- Nic: "if I go to the schedule because somebody just stopped in — RVs are, a
-- lot of people just show up, hey, can I get a night or two nights — if we find
-- a spot for them in the system, it needs to generate either a pay link from
-- the scheduling flow or send it to the point of sale for payment there in
-- person... we want to match up the inventory of the sales to the inventory of
-- the calendar."
--
-- The reservation flow had exactly one exit: email a deposit link. That is the
-- right answer for somebody who rang in February about March, and an absurd one
-- for a man standing at the desk with his rig idling outside.
--
-- So a reservation can now be handed to the till. The booking is written held
-- and unpaid the moment the site is chosen — inventory comes off the calendar
-- there, not at payment — and a ticket carrying that booking appears on the
-- register. The cashier rings it, and the SAME booking flips from held to sold.
-- One row from first click to paid: the sale cannot invent a second booking for
-- a site the schedule has already committed.
--
-- This is the same `pos_open_tickets` the propane deliveries use. A ticket was
-- always "a sale somebody will pay for elsewhere, later"; a reservation waiting
-- at the counter is that, with a site attached.

ALTER TABLE pos_open_tickets
  ADD COLUMN IF NOT EXISTS booking_id UUID REFERENCES unit_bookings(id);

COMMENT ON COLUMN pos_open_tickets.booking_id IS
  'S652: the held reservation this ticket is payment for. Settling the ticket confirms THAT booking rather than creating another — one row from the schedule to the till.';

CREATE INDEX IF NOT EXISTS pos_open_tickets_booking_idx
  ON pos_open_tickets (booking_id) WHERE booking_id IS NOT NULL;
