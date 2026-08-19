-- S605 (Nic): token-prefilled onboarding-call booking for self-signed-up landlords.
--
-- The post-signup outreach email (jobs/landlordWelcomeOutreach.ts) carries a
-- link to book an onboarding call. Asking a landlord who ALREADY has an account
-- to retype their name and email undercuts the whole point of an email meant to
-- read as a person who noticed them — so the link carries an opaque token that
-- the booking form trades server-side for their identity.
--
-- Why a token and not query params: the alternative is ?name=&email= in the URL,
-- which puts a customer's personal data into every mail-server log, browser
-- history, and Referer header it passes through. The token is a random uuid that
-- means nothing to anyone who intercepts it and can be expired or revoked.
--
-- Mirrors the existing booking_guest_access_tokens / business_customer_portal_
-- tokens pattern: unguessable value IS the credential, scoped to one subject,
-- with an expiry.
--
-- Deliberately NOT single-use: a landlord who books, then needs to reschedule
-- from the same email, should not hit a dead link. used_at is recorded for
-- visibility but never gates redemption. Expiry is the real bound.

CREATE TABLE IF NOT EXISTS landlord_onboarding_booking_tokens (
  id           uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  token        uuid NOT NULL UNIQUE DEFAULT public.gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  landlord_id  uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS landlord_onboarding_booking_tokens_landlord_idx
  ON landlord_onboarding_booking_tokens (landlord_id, created_at DESC);

COMMENT ON TABLE landlord_onboarding_booking_tokens IS
  'S605: opaque prefill credential for the onboarding-call booking link in the post-signup outreach email. Trades server-side for the landlord''s own name/email so the form does not re-ask. Not single-use — expiry is the bound, so a reschedule from the same email still works.';

-- ── Onboarding availability ───────────────────────────────────────────────
-- kind='onboarding' has been a valid value since S596 but never had a single
-- availability window, so nothing could ever actually book one. Seed the same
-- Mon–Fri 1–4pm Phoenix block the demo kind uses.
--
-- Overlapping the demo windows is intentional and safe: listAvailableSlots()
-- excludes every already-booked start REGARDLESS of kind (one rep, one
-- calendar), and sales_call_slots_booked_start_uniq enforces it at the DB. So
-- an onboarding call and a demo can never land on the same time.
INSERT INTO sales_call_availability (weekday, start_time, end_time, kind, active)
SELECT d, TIME '13:00', TIME '16:00', 'onboarding', TRUE
  FROM generate_series(1, 5) AS d
 WHERE NOT EXISTS (
   SELECT 1 FROM sales_call_availability WHERE kind = 'onboarding'
 );
