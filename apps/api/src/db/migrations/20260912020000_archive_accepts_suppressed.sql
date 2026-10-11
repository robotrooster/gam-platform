-- S641 follow-up — the ARCHIVE has to accept what the live table allows.
--
-- Adding 'suppressed' to email_send_log without widening its archive left a
-- delayed break: the nightly compliance archiver copies rows across, and the
-- first suppressed row to age out would have been refused by the archive's own
-- CHECK. Nothing would look wrong today — it would fail weeks later, in a cron
-- job, on a table nobody watches.
--
-- Caught by reading the constraint back after the migration rather than
-- trusting that one table was the whole story.
ALTER TABLE email_send_log_archive DROP CONSTRAINT IF EXISTS email_send_log_archive_status_check;
ALTER TABLE email_send_log_archive ADD CONSTRAINT email_send_log_archive_status_check
  CHECK (status IN ('sent', 'failed', 'suppressed'));

