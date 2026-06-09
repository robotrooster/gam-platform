-- S187: align onsite_manager_scopes with property_manager_scopes /
-- maintenance_worker_scopes by adding the all_properties boolean.
--
-- Why this exists: pre-S187 onsite_manager_scopes lacked the column,
-- so blanket "all properties under this landlord" coverage was
-- expressed as empty property_ids + empty unit_ids by convention. The
-- S185 fix in routeMaintenanceNotification used that empty-array
-- convention to filter the maintTeam fan-out, but it's inconsistent
-- with the other two scope tables and creates an undocumented schema
-- semantic. Promote the convention to an explicit column so
-- consumers don't have to know the empty-array trick.
--
-- Backfill: any existing onsite_manager_scopes row with both empty
-- property_ids AND empty unit_ids carried the implicit "all
-- properties" meaning. Set all_properties=true for those rows so the
-- post-migration semantic matches their pre-migration behavior under
-- the S185 maintTeam query.
--
-- New rows default to false to match the property_manager_scopes /
-- maintenance_worker_scopes posture (explicit opt-in for blanket
-- coverage). The INSERT in routes/scopes.ts is updated to accept the
-- field; PATCH on onsite_manager intentionally does NOT mutate the
-- column yet (no UI to flip it on existing rows; deferred until Nic
-- decides whether onsite needs blanket-coverage edit UX).
--
-- Consumed by:
--   - services/notifications.ts routeMaintenanceNotification
--     (S185 empty-array workaround can now read the column)
--   - routes/scopes.ts insertScopeRow + GET /team scope JSON

ALTER TABLE onsite_manager_scopes
  ADD COLUMN all_properties boolean NOT NULL DEFAULT false;

UPDATE onsite_manager_scopes
   SET all_properties = true
 WHERE property_ids = '{}'
   AND unit_ids = '{}';
