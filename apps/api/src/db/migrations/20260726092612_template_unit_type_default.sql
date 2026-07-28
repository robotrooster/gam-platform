-- S558 (Nic): let the landlord designate ONE template as the DEFAULT for a unit
-- type — the "primary apartment lease", "primary RV lease", etc. When a lease
-- auto-drafts off a unit, the pipeline grabs that unit type's default template
-- (and with it the deposit_months + default_term_months it carries). This is
-- the routing config that makes "set the unit type up right and it pulls the
-- right lease" work.
--
-- A default is scoped per (landlord, unit_type) and optionally narrowed to a
-- property (a property-locked template is that property's default for its unit
-- type; an unlocked one is the landlord-wide fallback). unit_type must be set
-- for a default (a default is by definition for a specific unit type — enforced
-- in the route, not here, since the flag column can't see unit_type in a CHECK
-- cheaply). No backfill (pre-launch; no template is a default until the
-- landlord marks one).
ALTER TABLE public.lease_templates
  ADD COLUMN is_unit_type_default boolean NOT NULL DEFAULT false;

-- At most one default per (landlord, unit_type, property_id). NULLS NOT
-- DISTINCT (PG15+) so two unlocked (property_id IS NULL) defaults for the same
-- unit type collide instead of both being allowed. The route also clears the
-- prior default on set (radio behaviour); this index is the hard backstop.
CREATE UNIQUE INDEX lease_templates_one_default_per_unit_type
  ON public.lease_templates (landlord_id, unit_type, property_id)
  NULLS NOT DISTINCT
  WHERE is_unit_type_default;
