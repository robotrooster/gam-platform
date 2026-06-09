-- Inspection reminder cron idempotency.
--
-- The 24h-before-scheduled reminder cron uses this column to avoid
-- pinging both parties twice if the cron runs again within the
-- reminder window. NULL = never reminded; populated on first send.
--
-- No backfill needed.

ALTER TABLE unit_inspections
  ADD COLUMN reminder_sent_at TIMESTAMPTZ;
