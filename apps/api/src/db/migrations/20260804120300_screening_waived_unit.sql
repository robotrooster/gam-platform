-- S579: record WHICH occupied unit a grandfather (screening waive) was granted
-- for, WITHOUT using pending_tenant_intents.unit_id.
--
-- WHY: the grandfather is "one per occupied unit" — enforcing that needs the
-- unit recorded. But `unit_id` on a LIVE intent triggers lease auto-draft on
-- invite-accept (autoDraftLeasesForUnit), which would collide with the e-sign
-- lease a grandfathered tenant signs separately (double draft). So the waive
-- records the occupied unit in a dedicated column that no auto-draft path reads.
-- No backfill needed (new column; no waives exist yet).

ALTER TABLE public.pending_tenant_intents
  ADD COLUMN IF NOT EXISTS screening_waived_unit_id uuid REFERENCES public.units(id);

CREATE INDEX IF NOT EXISTS idx_pending_intents_waived_unit
  ON public.pending_tenant_intents (screening_waived_unit_id)
  WHERE screening_waived_unit_id IS NOT NULL AND cancelled_at IS NULL;
