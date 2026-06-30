-- Move-in inspection 48h deadline + liability stamp (walkthrough Tenant #6, Nic 2026-06-26)
--
-- WHY: a tenant must complete their move-in inspection within 48 hours of the
-- lease start date. If they don't, they lose portal access until they finish,
-- and they assume liability for any conditions left undocumented. This column
-- stamps the moment that 48h window first lapses (the audit record of when the
-- liability shift took effect) so it's provable later, even after they finally
-- complete it.
--
-- NO BACKFILL NEEDED — nullable; only set when a deadline is actually missed.
ALTER TABLE public.unit_inspections
  ADD COLUMN IF NOT EXISTS move_in_deadline_missed_at timestamp with time zone;
