-- S607 (Nic, DIRECTIVE) — two changes to how a RUBS master shares a line.
--
-- 1. THE POOL SUBTRACTS DOLLARS, NOT USAGE.
--
--    Nic: "we set the utility rate at a penny per gallon for submeter usage for
--    water. We bill the entire rate, and then we need to subtract not the usage
--    from the pool for the RUBS, but the remaining dollar amount. That way it
--    still zeros out and divide the rest based on occupancy or whatever we're
--    doing."
--
--    The first cut billed submetered units at the master's BLENDED rate and
--    subtracted usage × that same rate — which only zeroes out because both
--    sides use one rate. The moment a submetered tenant is billed at a
--    different rate (a published penny-a-gallon, or a rate held down by a
--    ceiling) the arithmetic stops closing: the pool is short or over by the
--    difference, and nobody can see why.
--
--    Correct rule, and the one that always closes: subtract the DOLLARS the
--    submetered units were actually billed for consumption. Whatever rate they
--    paid, the remainder is what the pooled units divide, and every dollar of
--    the provider's bill lands on somebody.
--
-- 2. rubs_submeter_rate — WHAT RATE a submetered unit on the line pays.
--
--    'property_rate' (DEFAULT) — the property's own configured rate. What Nic
--      wants for the mobile homes: a published, predictable penny a gallon that
--      is the same number every month and easy to defend at the door. It also
--      matches how a submeter behaves under the usage_rate basis, so a submeter
--      does not silently change price because the master's basis changed.
--    'blended' — the master's blended rate, so every unit on the line pays the
--      identical cost per unit of usage and the pool carries no variance.
--
--    Both are in common use. Default is property_rate because it is the
--    behaviour a landlord already has, and because a rate they typed should not
--    be quietly overridden by one we derived.
--
-- No backfill: the default reproduces existing behaviour for every meter, and
-- no master is on the bill_amount basis yet.

ALTER TABLE utility_meters
  ADD COLUMN IF NOT EXISTS rubs_submeter_rate text NOT NULL DEFAULT 'property_rate';

ALTER TABLE utility_meters
  DROP CONSTRAINT IF EXISTS utility_meters_rubs_submeter_rate_check;
ALTER TABLE utility_meters
  ADD CONSTRAINT utility_meters_rubs_submeter_rate_check
  CHECK (rubs_submeter_rate = ANY (ARRAY['property_rate'::text, 'blended'::text]));

COMMENT ON COLUMN utility_meters.rubs_submeter_rate IS
  'S607: what rate a SUBMETERED unit on this master''s line is billed at. property_rate (default) = the property''s configured rate, unchanged from the usage_rate basis. blended = the master''s dollars ÷ usage. Either way the pool subtracts the dollars those units were actually billed, so the bill always closes.';
