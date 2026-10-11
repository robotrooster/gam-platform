-- S641 — an email we did NOT send must not be logged as sent.
--
-- Every message is written to email_send_log. When the environment has no mail
-- configured — a test run, a dev machine — the network call is skipped, but the
-- row was still stamped 'sent'. So the log said we emailed somebody when
-- nothing left the building, and there was no way to tell that row from one
-- Resend actually delivered.
--
-- It matters because that log is the answer to "did the tenant get their
-- notice?" A record that cannot distinguish "delivered" from "never left" is
-- worse than no record, since it is believed.
ALTER TABLE email_send_log DROP CONSTRAINT IF EXISTS email_send_log_status_check;
ALTER TABLE email_send_log ADD CONSTRAINT email_send_log_status_check
  CHECK (status IN ('sent', 'failed', 'suppressed'));

COMMENT ON COLUMN email_send_log.status IS
  'sent = handed to the provider. failed = the provider refused it. suppressed = this environment has no mail configured and nothing left the machine (S641).';
