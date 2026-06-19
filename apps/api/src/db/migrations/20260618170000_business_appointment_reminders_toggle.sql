-- Per-business opt-out of automated appointment reminders (S502).
--
-- S518 shipped 24h-before appointment reminders as always-on for any business
-- with appointments. Some operators don't want GAM emailing their customers.
-- This toggle (default ON, preserving current behavior) lets them turn it off;
-- the hourly reminder cron skips businesses where it's false.
--
-- No backfill needed — DEFAULT true keeps every existing business reminding.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS appointment_reminders_enabled boolean DEFAULT true NOT NULL;
