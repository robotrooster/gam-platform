-- unit_inspections report artifact (S573, Nic) — the finalize summary report.
--
-- WHY: on finalize, GAM generates a PDF inspection summary (items + conditions
-- + repair costs + the move-out-vs-move-in comparison detail that was previously
-- computed and discarded) and files it to BOTH parties — the tenant's Documents
-- and the landlord's reporting. report_url points at the served PDF; a companion
-- row is also written to `documents` (tenant_id set) so it appears in the tenant
-- portal's Documents tab automatically.
--
-- NO BACKFILL: only set going forward when an inspection is finalized.
ALTER TABLE unit_inspections
  ADD COLUMN IF NOT EXISTS report_url text,
  ADD COLUMN IF NOT EXISTS report_generated_at timestamp with time zone;
