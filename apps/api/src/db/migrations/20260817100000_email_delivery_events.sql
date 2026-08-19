-- S605 (Nic): delivery + engagement tracking for outreach email.
--
-- We had no idea whether the first organic landlord ever received his outreach
-- email. `email_send_log.status` only records whether the SEND ATTEMPT left the
-- building ('sent' | 'failed') — a hard bounce three days later was invisible,
-- so outreach could be silently going nowhere for every landlord on a bad
-- address and nothing would ever say so.
--
-- Deliberately NOT overloading `status`: "we handed it to Resend" and "the
-- recipient's server accepted it" are different facts and both matter. status
-- stays the send-attempt outcome; the delivery lifecycle lands in its own
-- columns.
--
-- Open tracking is intentionally NOT part of this (Nic briefed): it needs a 1x1
-- pixel, and Apple Mail Privacy Protection pre-fetches remote images for every
-- message, so "opened" is false-positive for a large share of recipients and
-- false-negative for anyone blocking images. The outreach email is also
-- deliberately image-free so it reads as a person rather than a campaign. The
-- honest engagement signal is the booking-link CLICK, recorded below, which is
-- first-party and unambiguous.
--
-- No backfill: existing rows keep NULL, meaning "no delivery event seen", which
-- is accurate — we weren't receiving the events.

ALTER TABLE email_send_log
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS last_event          text,
  ADD COLUMN IF NOT EXISTS last_event_at       timestamptz;

COMMENT ON COLUMN email_send_log.provider_message_id IS
  'S605: Resend message id. The join key for delivery webhooks — without it an inbound event cannot be matched back to the row we wrote at send time.';
COMMENT ON COLUMN email_send_log.last_event IS
  'S605: latest Resend lifecycle event — delivered | bounced | complained | delivery_delayed. NULL = none seen. Distinct from `status`, which is whether the send ATTEMPT succeeded.';

-- The webhook looks rows up by provider id on every event; without this it is a
-- sequential scan of the whole send log per event.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_send_log_provider_msg
  ON email_send_log (provider_message_id) WHERE provider_message_id IS NOT NULL;

-- Surfacing "which landlords have a bouncing address" is the actionable query.
CREATE INDEX IF NOT EXISTS idx_email_send_log_bad_delivery
  ON email_send_log (landlord_id, last_event_at DESC)
  WHERE last_event IN ('bounced', 'complained');

-- ── Booking-link engagement ───────────────────────────────────────────────
-- The outreach email's booking link carries an opaque token; opening it makes
-- the page call /api/sales/onboarding/prefill/:token. That request IS the read
-- receipt worth having — first-party, server-side, and it proves intent rather
-- than an image having loaded somewhere.
ALTER TABLE landlord_onboarding_booking_tokens
  ADD COLUMN IF NOT EXISTS first_clicked_at timestamptz,
  ADD COLUMN IF NOT EXISTS click_count      integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN landlord_onboarding_booking_tokens.first_clicked_at IS
  'S605: when the landlord first opened the booking link from the outreach email. The honest alternative to open-pixel tracking.';
