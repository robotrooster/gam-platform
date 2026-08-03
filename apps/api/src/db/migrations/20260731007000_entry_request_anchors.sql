-- S571 (Nic) — entry requests are anchored to a real, tenant-visible reason.
-- A landlord may request entry ONLY through (a) a specific maintenance call or
-- (b) a scheduled inspection. No more free-standing "showing / other / emergency"
-- entry — every entry now links to a record the tenant can already see, which
-- is the authenticity/history point (an "emergency" is just an emergency-
-- priority maintenance request).
--
-- Nullable + "at most one" CHECK (not "exactly one") so pre-S571 rows, which
-- have NEITHER anchor, still validate; the route enforces exactly-one on create.
ALTER TABLE unit_entry_requests
  ADD COLUMN IF NOT EXISTS maintenance_request_id uuid REFERENCES maintenance_requests(id),
  ADD COLUMN IF NOT EXISTS inspection_id uuid REFERENCES unit_inspections(id);

ALTER TABLE unit_entry_requests
  DROP CONSTRAINT IF EXISTS unit_entry_requests_single_anchor;
ALTER TABLE unit_entry_requests
  ADD CONSTRAINT unit_entry_requests_single_anchor
  CHECK (NOT (maintenance_request_id IS NOT NULL AND inspection_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_unit_entry_requests_maint ON unit_entry_requests(maintenance_request_id);
CREATE INDEX IF NOT EXISTS idx_unit_entry_requests_inspection ON unit_entry_requests(inspection_id);
