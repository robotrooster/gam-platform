-- S654: the monthly compliance archive (jobs/complianceArchive.ts) copies every
-- column of email_send_log into email_send_log_archive. S605 added three
-- columns to the live table only (20260817100000_email_delivery_events.sql),
-- so the 2026-10-01 run failed: column "provider_message_id" of relation
-- "email_send_log_archive" does not exist. It rolled back; nothing was lost.
-- S651 also widened the live status CHECK with 'undeliverable'; the archive
-- kept the old list, so the first archived undeliverable row would fail next.
--
-- Additive only (expand): nullable columns and a wider CHECK. Safe while any
-- build runs. No backfill needed — archived rows predate the columns.
ALTER TABLE email_send_log_archive
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS last_event          text,
  ADD COLUMN IF NOT EXISTS last_event_at       timestamptz;

ALTER TABLE email_send_log_archive DROP CONSTRAINT IF EXISTS email_send_log_archive_status_check;
ALTER TABLE email_send_log_archive ADD CONSTRAINT email_send_log_archive_status_check
  CHECK (status IN ('sent','failed','suppressed','undeliverable'));
