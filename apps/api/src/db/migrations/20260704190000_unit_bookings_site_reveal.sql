-- W-20 (final walkthrough, S531, Nic): fully-automatic schedule compression.
-- Sites are assigned in the system but NOT revealed to the guest until a
-- morning-of-check-in message delivers the site number. This stamp records
-- that the reveal message went out — and doubles as the compression fence:
-- a revealed booking is PINNED (the guest knows their site; the nightly
-- packer must not move it). NULL = not yet revealed, free to re-site.
-- Backfill: existing bookings stay NULL — the reveal cron only messages
-- same-day check-ins, so historical rows are never messaged.

ALTER TABLE unit_bookings
  ADD COLUMN site_reveal_sent_at timestamp with time zone;
