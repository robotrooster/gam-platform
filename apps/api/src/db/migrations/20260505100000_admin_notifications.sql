-- S132: admin notification surface.
--
-- Today, admin-relevant alerts (ACH retry confirm failures, allocation
-- engine breaks, post-commit pm_transfer failures, lease build
-- failures from e-sign) all route through console.error and disappear
-- into stdout. There is no in-app or email surface for super_admins to
-- see and triage these.
--
-- This table backs:
--   - GET  /api/admin/notifications (list with filters)
--   - POST /api/admin/notifications/:id/acknowledge
--   - createAdminNotification(opts) service helper
--
-- Severity drives whether email also fires:
--   info     → in-app row only
--   warn     → in-app row only (default)
--   critical → in-app row + email to all super_admins
--
-- Acknowledged rows stay in the table for audit; UI filters them out
-- by default. Retention policy lives in the broader compliance pass.

CREATE TABLE IF NOT EXISTS admin_notifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  severity          TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'critical')),
  category          TEXT NOT NULL,
  title             TEXT NOT NULL,
  body              TEXT,
  context           JSONB,
  acknowledged_at   TIMESTAMPTZ,
  acknowledged_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Most reads are "give me unacknowledged, ordered by recency."
-- Partial index keeps it tight even after the table grows.
CREATE INDEX IF NOT EXISTS idx_admin_notifications_unacked
  ON admin_notifications (created_at DESC)
  WHERE acknowledged_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_admin_notifications_category
  ON admin_notifications (category, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_notifications_severity
  ON admin_notifications (severity, created_at DESC);
