-- S651: GAM could not see which addresses its own mail provider had given up on.
--
-- Rashawn Bump's address hard-bounced on 2026-08-29. Resend put it on its
-- suppression list that same minute, and every one of the THIRTEEN emails sent
-- to him afterwards — invitations, reminders, two signing requests — was
-- accepted by the API, written into email_send_log as 'sent', and silently
-- dropped. No delivered event, no bounced event, no event at all. He was not
-- ignoring anybody; nothing ever arrived. Nic found out by asking.
--
-- A bounce at least produces a webhook. A SUPPRESSION produces nothing, ever,
-- which makes it the worse failure of the two: the send log reads like success
-- and there is no signal anywhere to contradict it.
--
-- So GAM keeps its own copy of what the provider refuses. Two jobs:
--   1. Refuse to send to an address we already know is dead, and say so in the
--      log instead of recording a send that will not happen.
--   2. Let the landlord see it. Nic: "the landlord can say, hey, the email that
--      you sent to this person was not received."
--
-- Kept as its own table rather than a flag on email_send_log because it is a
-- fact about an ADDRESS, not about a message: it must be knowable before the
-- first send to that address, not inferred after one has failed.

CREATE TABLE email_suppressions (
  email        TEXT PRIMARY KEY,
  -- 'bounce'    — the mailbox rejected it outright
  -- 'complaint' — somebody marked GAM as spam
  -- 'manual'    — added by hand, in the dashboard or by us
  origin       TEXT NOT NULL,
  provider_id  TEXT,
  -- when the PROVIDER suppressed it, not when we learned
  suppressed_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE email_suppressions IS
  'S651: addresses the mail provider will not deliver to, mirrored locally. A suppressed address produces NO delivery event of any kind, so without this a send to one is indistinguishable from a successful send. Synced nightly; read before every send.';

-- Lowercased on the way in by the sync; this makes the lookup on the send path
-- a single index probe.
CREATE INDEX email_suppressions_synced_idx ON email_suppressions (last_synced_at DESC);

-- email_send_log.status gains a value that means "we did not even try, because
-- we already knew". Distinct from 'suppressed', which has meant since S641
-- "this environment does not send mail at all" — conflating the two would
-- make a dev-box no-op and a dead tenant address read identically.
ALTER TABLE email_send_log DROP CONSTRAINT IF EXISTS email_send_log_status_check;
ALTER TABLE email_send_log ADD CONSTRAINT email_send_log_status_check
  CHECK (status IN ('sent', 'failed', 'suppressed', 'undeliverable'));

COMMENT ON COLUMN email_send_log.status IS
  'sent = handed to the provider. failed = the provider refused it. suppressed = this environment does not send mail (dev/demo). undeliverable = S651, the address is on the provider suppression list and we did not try.';
