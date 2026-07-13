-- S536 (Nic): SMS is removed platform-wide — notifications and receipts
-- are email or in-app ONLY. No SMS provider was ever wired (the sender
-- was a logging stub), so these columns never carried real state:
-- notifications.sms_sent was FALSE / sms_sent_at NULL on every row, and
-- notification_preferences.sms_enabled toggled a channel that didn't
-- exist. Safe drop — no data loss beyond dead flags; no backfill needed.
ALTER TABLE notifications DROP COLUMN sms_sent;
ALTER TABLE notifications DROP COLUMN sms_sent_at;
ALTER TABLE notification_preferences DROP COLUMN sms_enabled;
