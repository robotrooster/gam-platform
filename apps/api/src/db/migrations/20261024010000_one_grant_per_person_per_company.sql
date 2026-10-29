-- 10/23 — ONE GRANT PER PERSON PER COMPANY.
--
-- The worker scope tables are keyed (user_id, landlord_id) in every read that
-- matters — a property names its company, and that company's row decides what
-- the person may touch there (middleware/auth). But nothing stopped a second row
-- for the same pair, and with the management portal folding in there is now a
-- writer that upserts them: a management company's people get a row per owner
-- they manage for (services/managedAccess).
--
-- Two rows for one pair is not a shape any rule here has an answer for — which
-- of the two is their access? — so it is made impossible instead of handled.
--
-- No backfill needed and nothing to clean: there are no duplicate pairs today
-- (property_manager_scopes has no rows at all, onsite has one).
CREATE UNIQUE INDEX IF NOT EXISTS ux_property_manager_scopes_person_company
  ON property_manager_scopes (user_id, landlord_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_onsite_manager_scopes_person_company
  ON onsite_manager_scopes (user_id, landlord_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_maintenance_worker_scopes_person_company
  ON maintenance_worker_scopes (user_id, landlord_id);
