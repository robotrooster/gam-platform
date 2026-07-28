-- S558 fix-forward: drop the partial unique index added in
-- 20260726092612. It collides on a legitimate path: lease_templates.property_id
-- has ON DELETE SET NULL, so deleting a property whose template is a
-- property-locked default collapses that row's property_id to NULL — and if the
-- landlord also has an unlocked default for the same unit type, the two now
-- share key (landlord, unit_type, NULL) and the cascade errors out. The
-- one-default-per-(landlord, unit_type, property) rule is enforced in the route
-- (POST /esign/templates/:id/set-default clears the prior default before
-- setting, radio-style), which is sufficient. A non-unique lookup index remains
-- useful, so replace with a plain one.
DROP INDEX IF EXISTS public.lease_templates_one_default_per_unit_type;

CREATE INDEX lease_templates_unit_type_default_lookup
  ON public.lease_templates (landlord_id, unit_type)
  WHERE is_unit_type_default;
