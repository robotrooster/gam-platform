-- S67: admin_action_log table.
--
-- Creates the audit log row that admin.ts:216 (and future admin tooling)
-- writes to whenever an admin performs a manual action affecting another
-- user's data. The original code site at admin.ts:221 wrote to this table
-- but wrapped in `.catch(() => null)` because the table didn't exist —
-- silently swallowing every audit attempt for over a year.
--
-- Distinct from `audit_log` (general-purpose entity-attribution log used
-- by S66 super_admin bank reveal). admin_action_log is specifically for
-- admin-driven workflows: resends, manual overrides, force-cancels, etc.,
-- where the row is descriptive rather than entity-typed.
--
-- No backfill — pre-existing resend events are gone.

CREATE TABLE admin_action_log (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_user_id UUID NOT NULL REFERENCES users(id),
  action_type  TEXT NOT NULL,
  target_id    UUID,
  target_type  TEXT,
  notes        TEXT,
  metadata     JSONB,
  ip_address   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_admin_action_log_admin ON admin_action_log(admin_user_id, created_at DESC);
CREATE INDEX idx_admin_action_log_target ON admin_action_log(target_id) WHERE target_id IS NOT NULL;
CREATE INDEX idx_admin_action_log_action ON admin_action_log(action_type, created_at DESC);
