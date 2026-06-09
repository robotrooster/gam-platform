-- S157: landlords.default_pm_company_id — landlord-level default PM company.
--
-- Resolution rule for "which PM manages this property":
--   1. properties.pm_company_id (per-property override) wins when set
--   2. else fall back to landlords.default_pm_company_id
--   3. else null (owner self-manages)
--
-- The helper services/pm.ts → getPmCompanyForProperty(propertyId) is the
-- single read-path consumer. Allocation engine + maintenance notification
-- + invitation conflict checks all go through it.
--
-- Why not a join-table abstraction (pm_property_links per the original
-- S156 sketch): the existing properties.pm_company_id model from S108 is
-- already wired into allocation, fee-plan FK invariant, and the
-- /pm-assignment route. Wrapping a links table around it would be
-- redundant. The default field is the only thing missing for
-- assignment-granularity option C (both levels).
--
-- ON DELETE SET NULL — if a pm_company is deleted, the landlord's default
-- pointer just nulls out (each property still has its own pm_company_id
-- which has its own SET NULL behavior from S108).
--
-- No backfill needed (column nullable; no existing landlord has a default).

ALTER TABLE landlords
  ADD COLUMN default_pm_company_id uuid REFERENCES pm_companies(id) ON DELETE SET NULL;

CREATE INDEX idx_landlords_default_pm_company
  ON landlords(default_pm_company_id)
  WHERE default_pm_company_id IS NOT NULL;
