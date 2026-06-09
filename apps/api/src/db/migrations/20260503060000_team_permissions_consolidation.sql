-- S80 / Item 8a: consolidate team permissions onto scope tables.
--
-- Pre-S80 model had two parallel concepts:
--   1. team_members table — pre-S62 cruft. (landlord_id, user_id, role,
--      permissions jsonb, status). Read by routes/team.ts (dead code
--      referencing phantom team_property_access) and auth.ts login,
--      written by nothing live. Zero rows in dev.
--   2. *_scopes tables (S62 era) — property_manager_scopes,
--      onsite_manager_scopes, maintenance_worker_scopes, bookkeeper_scopes.
--      Per-role scope binding (which properties / units / job categories /
--      access level). Live and used; routes/scopes.ts manages them via
--      the invitations workflow.
--
-- S79 added the sub-permission catalog to packages/shared. The catalog
-- needs a single home. The choice between "dual-write team_members on
-- accept" and "fold permissions onto each scope table" landed on the
-- latter: one row per role, scope and feature toggles in the same place,
-- no dual-write to keep in sync.
--
-- Bookkeeper is intentionally excluded from per-feature toggles — the
-- existing access_level column (read_only | read_write) is the right
-- granularity for that role per the S79 product call.
--
-- Migration:
--   1. Add permissions jsonb DEFAULT '{}' to the 3 toggle-eligible
--      scope tables. NOT NULL with default so no backfill needed.
--   2. Drop team_members. Zero rows in dev; the pre-S79 admin shipping
--      checklist confirms no production dependency. routes/team.ts is
--      ripped in the same session (S80 file delete).
--
-- Callers updated in S80:
--   - routes/auth.ts login: replace LEFT JOIN team_members with a
--     role-keyed dispatch into the right scope table for permissions +
--     landlord_id JWT claims.
--   - services/notifications.ts:149 (maintenance team notify): switch
--     from team_members join to UNION across maintenance_worker_scopes
--     and onsite_manager_scopes.
--
-- No backfill: zero rows in team_members.

ALTER TABLE property_manager_scopes
  ADD COLUMN permissions jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE onsite_manager_scopes
  ADD COLUMN permissions jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE maintenance_worker_scopes
  ADD COLUMN permissions jsonb NOT NULL DEFAULT '{}'::jsonb;

DROP TABLE team_members;
