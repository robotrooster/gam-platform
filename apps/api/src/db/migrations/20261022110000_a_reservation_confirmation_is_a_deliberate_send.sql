-- 10/20 (Nic) — A CONFIRMATION IS SOMETHING SOMEBODY CHOOSES TO SEND.
--
--   "the confirmation actually says that they have a reservation on these
--    dates ... Have it display that as available to pay now. But I also want
--    it to not be required"
--
-- and, about everything that comes in from the old system or off a text
-- thread:
--
--   "So I don't want the import to do anything. I just want it to import
--    straight across."
--
-- A reservation can therefore be on the schedule for weeks with the guest
-- never having heard from GAM — they were told they were confirmed by Nic, in
-- the old system, before any of this existed. The confirmation is a separate,
-- deliberate act later, and these two columns are the record of it: WHO sent
-- it and WHEN.
--
-- Why it needs a record at all, rather than just sending: nothing else on
-- unit_bookings can answer "has this guest been told?". Without an answer the
-- desk cannot tell a guest who has heard from us from one who has not, which
-- is how somebody gets the same email five times in an afternoon — and with
-- real customers mid-migration, an accidental blast is the worst outcome of
-- this whole build. It is also what paces a second press: a resend an hour
-- later is a guest who lost the email, a resend a minute later is a double
-- click.
--
-- It is the same shape as the stamps already beside it — deposit_link_sent_at
-- / deposit_link_sent_by and site_reveal_sent_at — deliberately, so the
-- schedule reads "has been asked / has been told" the one way everywhere.
--
-- NO BACKFILL. Every row that exists today has had no confirmation sent from
-- GAM, which is exactly what NULL says. Backfilling a timestamp would claim
-- GAM emailed people it never emailed.
ALTER TABLE unit_bookings
  ADD COLUMN IF NOT EXISTS confirmation_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmation_sent_by uuid REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN unit_bookings.confirmation_sent_at IS
  'When a person chose to email this guest their reservation confirmation. NULL = never told. Never set by a job or a hook — see services/bookingConfirmation.';
COMMENT ON COLUMN unit_bookings.confirmation_sent_by IS
  'Who pressed send on the confirmation.';
