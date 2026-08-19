-- S605 (Nic): automated onboarding-call outreach for SELF-SIGNED-UP landlords.
--
-- Our first organic signup (S605) created an account, hit the onboarding wizard,
-- and left 16 seconds later. Nothing reached out to him — the only signup
-- artifact was an internal admin alert. Nic's rule: every landlord who finds us
-- on their own gets a personal-feeling note offering an onboarding call, sent
-- ~90 minutes after signup so it reads as a human noticing rather than a
-- machine firing on INSERT.
--
-- This column is the durable idempotency marker. It deliberately does NOT live
-- in email_send_log: that table is archived on a schedule
-- (email_send_log_archive), so a log-based "have we sent this?" check would
-- start returning false once rows aged out and re-email landlords months later.
--
-- Backfill: every EXISTING landlord is stamped as already-sent. Without this the
-- job's first run would blast the entire back catalogue of landlords with a
-- "welcome, let's get you set up" email. Only accounts created from here on
-- qualify.
--
-- No new index: the job's WHERE is time-bounded to a narrow recent window and
-- the landlords table is small; a partial index can come if that stops holding.

ALTER TABLE landlords
  ADD COLUMN IF NOT EXISTS welcome_outreach_sent_at timestamptz;

COMMENT ON COLUMN landlords.welcome_outreach_sent_at IS
  'S605: when the automated post-signup onboarding-call outreach was sent. NULL = not yet sent (or not eligible). Set once, never cleared — the idempotency guard for jobs/landlordWelcomeOutreach.ts.';

-- Suppress the back catalogue (see header).
UPDATE landlords SET welcome_outreach_sent_at = now() WHERE welcome_outreach_sent_at IS NULL;
