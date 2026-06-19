-- S518: appointment reminder one-shot flag.
--
-- The reminder cron emails the customer ~24h before a scheduled
-- appointment to cut no-shows. `reminder_sent_at` is the idempotency
-- guard so each appointment is reminded exactly once (mirrors the
-- e-sign `reminder_sent_at` pattern). NULL = not yet reminded.
--
-- SAFE — additive only, nullable, no backfill (existing future
-- appointments simply get reminded when they enter the 24h window;
-- past appointments never match the cron's window filter).

ALTER TABLE public.appointments
  ADD COLUMN reminder_sent_at timestamp with time zone;

COMMENT ON COLUMN public.appointments.reminder_sent_at IS
  'S518 set when the 24h reminder email fires. One-shot idempotency guard for the reminder cron.';
