-- S582: tenant invite-nudge tracking.
--
-- WHY: a 7-day tenant invite that's never accepted just lapses silently (the
-- landlord only finds out via the onboarding control tower AFTER it expires).
-- A daily job now nudges the tenant before it lapses (reduces drop-off). This
-- column records when we last nudged an intent so the daily job spaces reminders
-- (~every 2 days in the back half of the window) instead of emailing every day.
--
-- No backfill needed (nullable; a NULL means "never nudged" → eligible).

ALTER TABLE pending_tenant_intents
  ADD COLUMN IF NOT EXISTS invite_last_nudged_at timestamptz;
