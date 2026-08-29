-- S629 (Nic, DIRECTIVE — supersedes S613): "pricing should not necessarily be
-- linked to subtypes, as things that have different subtypes may be differently
-- priced. The subtype is more just for classification, reporting type things —
-- we can later on determine how many people wanted 30 amp versus 50 amp spots,
-- how many preferred back-in versus pull-through. It's more of a reporting
-- metric and portfolio statistic gauge than a pricing gauge. Pricing should be
-- per individual unit, or settable per unit. Obviously on bulk unit creation
-- you can default set a bunch of things the same price for quickness."
--
-- S613 modelled a subtype as owning the price of every unit in it, enforced in
-- the database by two triggers:
--
--   enforce_subtype_pricing   — BEFORE INSERT OR UPDATE ON units, overwriting
--                               the unit's price with the class's on EVERY
--                               write, so a per-unit price could not survive
--                               even if a route allowed it.
--   propagate_subtype_pricing — AFTER UPDATE ON property_unit_subtypes,
--                               pushing a class price change onto every unit
--                               already in it.
--
-- Both go. A class is a LABEL — it answers "how many 50-amp back-ins do we
-- have", not "what do they cost" — and two units wearing one label can be worth
-- different money. Propagation is the more dangerous of the two: editing a
-- class silently repriced units that may already have been quoted or advertised
-- at a figure.
--
-- The subtype keeps its price columns and they remain a DEFAULT at creation:
-- routes/units.ts reads `body.rentAmount ?? sub.rent_amount`, so bulk-adding
-- twenty spots at one price is still one action. A default is copied once; a
-- link keeps reaching back, and that is the part being removed.

DROP TRIGGER IF EXISTS trg_enforce_subtype_pricing ON public.units;
DROP TRIGGER IF EXISTS trg_propagate_subtype_pricing ON public.property_unit_subtypes;
DROP FUNCTION IF EXISTS public.enforce_subtype_pricing();
DROP FUNCTION IF EXISTS public.propagate_subtype_pricing();

COMMENT ON COLUMN public.property_unit_subtypes.rent_amount IS
  'S629: a DEFAULT applied when a unit is created in this class, not a live link. Each unit owns its price after that; the subtype is a classification for reporting.';
