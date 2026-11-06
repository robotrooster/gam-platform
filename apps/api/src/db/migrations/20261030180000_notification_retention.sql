-- 10/30 (Nic): notifications never went away. Nothing deleted them, nothing
-- expired them, and production had 697 rows — oldest from 24 August, only 184
-- ever read — for residents who until today had no way to read them at all. A
-- resident two years in would scroll hundreds.
--
-- His rule, and the reason it is a HIDE and not a delete:
--
--   "It might be worth having history of the notifications on the server side.
--    So if there's ever an issue where it's like, hey, we notified you freaking
--    27 times about this thing over the course of 4 months, there's at least a
--    record of it, a record of them clicking on said notifications... proof of
--    receipt sort of thing."
--
-- So rows STAY. Both columns below only decide whether a resident still sees a
-- notice in their own list; every row, its read_at, and now its dismissed_at
-- remain queryable forever. Same posture as the rest of GAM, which never erases.
--
-- retention_from, not created_at, is what the 60-day clock runs from. Nic chose
-- to start the clock AT DEPLOY rather than retroactively: a retroactive clock
-- would hide roughly two months of notices the moment this ships, including
-- ones nobody has ever read. Backfilling every existing row to now() gives them
-- all a fresh 60 days from today, and new rows get their creation time, after
-- which the two are the same thing forever.
--
-- NO BACKFILL RISK: both columns are additive, every existing row gets a value,
-- and nothing reads them until the API ships alongside.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS retention_from timestamptz,
  ADD COLUMN IF NOT EXISTS dismissed_at   timestamptz;

-- Existing rows: the clock starts now, so nothing vanishes on deploy day.
UPDATE notifications SET retention_from = NOW() WHERE retention_from IS NULL;

ALTER TABLE notifications
  ALTER COLUMN retention_from SET DEFAULT NOW(),
  ALTER COLUMN retention_from SET NOT NULL;

-- The feed reads "mine, not dismissed, not aged out", newest first.
CREATE INDEX IF NOT EXISTS idx_notifications_visible
  ON notifications (user_id, retention_from DESC)
  WHERE dismissed_at IS NULL;
