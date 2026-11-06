-- The link a guest follows to add a picture of their licence.
--
-- Nic, 10/29, on where the ask belongs:
--
--   "Deposit is already paid during booking for people that do it online. For
--    people that call in to make a reservation, it's the way I said it. It
--    emails them a link for a deposit. Ask for the ID during the deposit
--    checkout that they already go through. No sign in, no flow change."
--
-- The deposit link hands straight off to Stripe's own checkout, which cannot
-- host a file upload, so the ask sits on the GAM page the guest lands on when
-- the payment is done — nothing added before paying, and no sign-in.
--
-- WHY A SEPARATE TOKEN AND NOT THE PAY LINK'S. A pay-link token is a payment
-- credential and a standing one is opened by anybody who scans the code; this
-- token carries the right to attach an identification to ONE booking and
-- nothing else. Minted on the booking so no new table is needed.
--
-- No backfill: a booking with no token simply has no capture page, which is
-- what every booking before today has.

ALTER TABLE unit_bookings
  ADD COLUMN IF NOT EXISTS id_capture_token text,
  ADD COLUMN IF NOT EXISTS id_capture_asked_at timestamptz;

COMMENT ON COLUMN unit_bookings.id_capture_token IS
  'Bearer token for the guest''s own ID-capture page. Attaches an identification to THIS booking and nothing else — never a payment credential.';
COMMENT ON COLUMN unit_bookings.id_capture_asked_at IS
  'When the guest was first shown the ask, so a second visit is not a second request.';

CREATE UNIQUE INDEX IF NOT EXISTS ux_unit_bookings_id_capture_token
  ON unit_bookings (id_capture_token) WHERE id_capture_token IS NOT NULL;
