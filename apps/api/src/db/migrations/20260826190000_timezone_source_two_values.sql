-- S624 — drop the 'inferred' timezone state.
--
-- The first cut of property timezones resolved fifteen split states by ZIP and
-- marked the ragged boundaries 'inferred', so the landlord could confirm them.
-- Nic cut that the same session: "if it's only detecting when late fees go on
-- and stuff like that, who's really likely to pay at midnight? It can be off by
-- an hour. It's not a big deal. We'll address it in the future if it gets to
-- that point where it's a real problem."
--
-- He is right. Grace periods are measured in DAYS, so an hour of drift changes
-- an outcome only for a tenant paying within sixty minutes of local midnight on
-- the last day of grace — and it errs in the tenant's favour, on one day's fee.
-- Set against that: a fifteen-state ZIP table that is wrong at the edges anyway
-- (the boundary follows counties, not postal ranges), goes stale silently, and
-- asks landlords to confirm something they neither know nor care about. It was
-- precision nobody had asked for, priced in complexity everybody would carry.
--
-- What survives is the part that actually matters: 'manual' means a human set
-- the zone and no derivation may overwrite it. That is the escape hatch for the
-- Navajo Nation, El Paso, the Florida panhandle and everywhere else in the
-- minority half of a split state — and it is the whole mechanism this needs
-- until the problem is real.

UPDATE properties SET timezone_source = 'derived' WHERE timezone_source = 'inferred';

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_timezone_source_check;
ALTER TABLE properties ADD CONSTRAINT properties_timezone_source_check
  CHECK (timezone_source = ANY (ARRAY['derived','manual']));

ALTER TABLE properties ALTER COLUMN timezone_source SET DEFAULT 'derived';

COMMENT ON COLUMN properties.timezone_source IS
  'S624: derived = from the property state; manual = a human set it and no derivation may overwrite it.';
