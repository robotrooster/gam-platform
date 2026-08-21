-- S613 (Nic): which charges a work-trade agreement actually covers.
--
--   "If people are on a work trade agreement, those things might not be
--    included at some properties. They need to be selectable as to whether they
--    are included in the agreement. It would be like they did fifty percent of
--    the work for the rent and the electric, and it bills them fifty percent of
--    the electric, but propane is excluded — so they get a hundred percent of
--    the propane bill. I have different agreements with different people here."
--
-- PER AGREEMENT, not per property, for the same reason the hours target is per
-- agreement (W-56): different people do different work for different deals, and
-- a property-wide setting would force one bargain onto everyone.
--
-- The subtlety worth stating, because getting it wrong is invisible: an excluded
-- charge must stop GENERATING credit as well as stop receiving it. The credit is
-- a percentage of a basis, so leaving propane in the basis would have the
-- tenant's labour buy dollars off a bill they are supposed to pay in full — the
-- excluded charge would quietly discount everything else. Excluded rows leave
-- the basis and the distribution both.
--
-- Default is EVERYTHING, so every agreement that exists today keeps the exact
-- deal it has now and nobody's bill moves when this ships.
ALTER TABLE work_trade_agreements
  ADD COLUMN IF NOT EXISTS covered_charges text[] NOT NULL
    DEFAULT ARRAY['rent','fees','water','sewer','electric','gas','trash','propane'];

ALTER TABLE work_trade_agreements DROP CONSTRAINT IF EXISTS work_trade_covered_charges_check;
ALTER TABLE work_trade_agreements ADD CONSTRAINT work_trade_covered_charges_check
  CHECK (covered_charges <@ ARRAY['rent','fees','water','sewer','electric','gas','trash','propane']);

COMMENT ON COLUMN work_trade_agreements.covered_charges IS
  'S613: what this agreement trades for. A charge NOT listed is billed in full '
  'and takes no part in the credit basis. Default is everything, which is the '
  'behaviour every pre-S613 agreement had.';
