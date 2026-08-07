-- S579: property-level screening linkage.
--
-- WHY: a background check must link to the specific PROPERTY it was run for
-- (Nic — "this check belongs to Oak Park"), decided at landlord-invite time,
-- BEFORE any unit is assigned or lease exists. Today `pending_tenant_intents`
-- and `background_checks` carry landlord_id + a nullable unit_id but no
-- property_id, so a property-level (unit-not-yet-chosen) screening invite has
-- nowhere to record which property it belongs to. Add it to both.
--
-- Property-level invites bind the property directly (unit_id NULL); unit-bound
-- rows can still derive the property from the unit. No backfill needed — new
-- column, existing rows keep deriving property from their unit.

ALTER TABLE public.pending_tenant_intents
  ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES public.properties(id);

ALTER TABLE public.background_checks
  ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES public.properties(id);

CREATE INDEX IF NOT EXISTS idx_pending_tenant_intents_property
  ON public.pending_tenant_intents (property_id) WHERE property_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_background_checks_property
  ON public.background_checks (property_id) WHERE property_id IS NOT NULL;
