-- 10/18 (Nic) — ASKING FOR THE DEPOSIT AFTER THE RESERVATION IS ALREADY MADE
--
--   "yeah, let's add a button so that we can collect deposits from people that
--    haven't done it for their stays."
--
-- Until today a deposit link could only be sent at the ONE moment a
-- reservation was created ("+ Book" / New Reservation, sendDepositLink). Every
-- reservation taken without one — the phone calls, the soft holds somebody
-- wrote down and meant to come back to — had no way to be asked for its
-- deposit afterwards, so the desk could never turn a soft hold into a locked-in
-- one. S652's rule says a reservation is only locked in once a deposit lands,
-- and the only door to that was shut a minute after the reservation was made.
--
-- WHICH LINK IS THIS RESERVATION'S DEPOSIT LINK (deposit_pay_link_id).
-- A reservation can have more than one link against it in its life: the one
-- that created it from the register's "Send link", an "Add a month" link, the
-- arrival-day balance link (balance_pay_link_id, beside this one), and the
-- deposit link. They ask for different money. Without this column the only
-- way to find "the deposit link" was "an open link on this reservation that is
-- not the balance one", which hands the desk a link for the WHOLE stay and
-- calls it the deposit — so the number read down the phone is wrong and the
-- deposit is never asked for at all. The link that was made as the deposit
-- says so here. Same shape and the same job as balance_pay_link_id on this
-- table.
--
-- The other two columns are what the schedule reads to say the guest HAS been
-- asked (so the desk does not ask the same person four times), and what paces
-- the asking: a second press within the hour never emails again, the way the
-- lease signing Remind button paces itself (routes/esign /documents/:id/remind).
-- Stamped only when an email really went out — a send that failed is not an ask.
--
-- Same shape as returning_guest_at / returning_guest_by on this table: when,
-- and who said so, and the user reference lets go rather than pinning the row
-- (ON DELETE SET NULL, as returning_guest_by has).
--
-- Expand only. No backfill, deliberately: links emailed before today have no
-- send time to recover, and the only way to pick a deposit link out of the
-- links already in the table is to match the words on it — which is exactly
-- the kind of guess these columns exist to replace. A reservation whose
-- deposit link went out before today is still handed that link when the button
-- is pressed, named by the label the link itself carries ("Reservation
-- deposit", and its amount); it just is not recognized as THE deposit link, so
-- the words are "there is already a link out for this reservation" rather than
-- "this is the same link". Nothing is sent twice either way, and the figure
-- read down the phone is the link's own.
ALTER TABLE unit_bookings
  ADD COLUMN IF NOT EXISTS deposit_link_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS deposit_link_sent_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deposit_pay_link_id uuid REFERENCES pos_pay_links(id);

COMMENT ON COLUMN public.unit_bookings.deposit_link_sent_at IS
  '10/18 (Nic): when this reservation''s deposit link was last emailed to the guest — by the reservation form, or by the schedule''s Ask for the deposit button. Paces a second press (nothing is emailed again within the hour) and tells the schedule the guest has been asked. NULL = never asked.';
COMMENT ON COLUMN public.unit_bookings.deposit_link_sent_by IS
  '10/18 (Nic): who asked. NULL for a link GAM sent itself (the booking site).';
COMMENT ON COLUMN public.unit_bookings.deposit_pay_link_id IS
  '10/18 (Nic): the pay link that was made as THIS reservation''s deposit (routes/posPayLinks createBookingDepositLink). Beside balance_pay_link_id, which is the arrival-day balance link. A reservation can also carry the link that created it, or an Add-a-month link; those ask for other money and are never handed back as the deposit.';
