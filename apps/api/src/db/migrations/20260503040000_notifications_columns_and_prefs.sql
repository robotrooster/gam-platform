-- S68: notifications schema fix-forward + notification_preferences table.
--
-- The S64-era notification service (services/notifications.ts) and routes
-- (routes/notifications.ts) were written assuming 7 columns and a
-- notification_preferences table that never landed. Every INSERT was
-- hitting nonexistent columns and silently failing inside try/catch — the
-- entire notification system has been a no-op since the service was
-- written.
--
-- This migration adds the missing surface so the existing code starts
-- working. No data loss risk: the notifications table currently has only
-- rows whose INSERT didn't reference these columns.

-- 1. Add the 7 phantom columns to notifications.
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS data         JSONB,
  ADD COLUMN IF NOT EXISTS landlord_id  UUID REFERENCES landlords(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS read_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_sent   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sms_sent     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sms_sent_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id, created_at DESC) WHERE read = FALSE;
CREATE INDEX IF NOT EXISTS idx_notifications_landlord
  ON notifications(landlord_id, created_at DESC) WHERE landlord_id IS NOT NULL;

-- 2. Create notification_preferences table.
--
-- Per-(user, type) channel toggles. The service defaults to:
--   email_enabled=TRUE, sms_enabled=FALSE, in_app_enabled=TRUE
-- when no row exists, so absence of a row = sensible defaults.
--
-- type is intentionally TEXT (not enum) — the notification type vocabulary
-- evolves frequently and a CHECK would force re-migrations on every change.
-- Vocabulary lives in the service file as the single source of truth.
CREATE TABLE notification_preferences (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  email_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  sms_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  in_app_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX ux_notification_preferences_user_type
  ON notification_preferences(user_id, type);

CREATE TRIGGER trg_notification_preferences_updated_at
  BEFORE UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
