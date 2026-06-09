-- S133: archive sibling tables for compliance/audit logs.
--
-- Policy: GAM keeps all compliance/audit data forever (retention is
-- "as long as legally allowed"). To prevent the hot tables from
-- growing unbounded and slowing down day-to-day reads, rows older
-- than 24 months get moved to a `<table>_archive` sibling. Archive
-- tables are queryable by admin tooling on demand but excluded from
-- the default operational paths.
--
-- Archive table differences from the hot table:
--   - Columns + defaults + CHECK constraints copied (LIKE INCLUDING)
--   - Foreign keys NOT copied — referenced rows (users, payments,
--     etc.) may be deleted long after the archive row is written;
--     archives are append-only history, not relational current state
--   - Adds `archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` so we
--     know when each row was moved out of the hot table
--   - No indexes initially — archive is rarely scanned; add later
--     if a query pattern emerges
--
-- Six tables get archive siblings:
--   admin_action_log, audit_log, bulletin_reveal_log,
--   ach_monitoring_log, admin_notifications, email_send_log
--
-- Cron-driven archival runs in scheduler.ts (S133); cutoff =
-- 24 months. admin_notifications additionally requires
-- acknowledged_at IS NOT NULL — never archive an active alert.

CREATE TABLE IF NOT EXISTS admin_action_log_archive (
  LIKE admin_action_log INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log_archive (
  LIKE audit_log INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bulletin_reveal_log_archive (
  LIKE bulletin_reveal_log INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ach_monitoring_log_archive (
  LIKE ach_monitoring_log INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_notifications_archive (
  LIKE admin_notifications INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_send_log_archive (
  LIKE email_send_log INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
