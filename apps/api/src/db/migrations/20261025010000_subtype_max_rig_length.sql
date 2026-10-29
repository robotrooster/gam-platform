-- 10/24 (Nic) — A SITE CLASS CARRIES ITS LENGTH, SO NOBODY TYPES IT 100 TIMES.
--
--   "I'm trying to make a reservation right now where somebody's got a 37 foot
--    camper. They can't go in the small sites, right?"
--
-- 20261025000000 gave the SITE a maximum rig length and the RESERVATION the
-- rig's length. This adds the same number to the site CLASS, exactly where
-- rv_site_layout and rv_amp_service already live: a park that has "Big rig
-- pull-through" and "Back-in compact" as subtypes says 45 and 28 once, and
-- every site of that class inherits it the same way it inherits its layout and
-- its amps (units.ts: body.rvSiteLayout ?? sub?.rv_site_layout ?? 'none').
--
-- A subtype is a classifier, never a price (standing directive), and a length
-- is a fact about the pad — the same kind of fact as "pull through".
--
-- NO BACKFILL NEEDED. NULL everywhere means "no stated limit", which fits every
-- site; isRigTooLongForSite() in packages/shared treats a missing limit as a
-- fit, so no existing park's availability changes until somebody fills it in.
ALTER TABLE property_unit_subtypes
  ADD COLUMN IF NOT EXISTS rv_max_rig_length_ft INTEGER;

-- Same sanity bound as units.rv_max_rig_length_ft: a real rig, not a typo.
-- 120 ft is past the longest legal combination on any US highway.
ALTER TABLE property_unit_subtypes
  DROP CONSTRAINT IF EXISTS property_unit_subtypes_rig_length_sane;
ALTER TABLE property_unit_subtypes
  ADD CONSTRAINT property_unit_subtypes_rig_length_sane
  CHECK (rv_max_rig_length_ft IS NULL
         OR (rv_max_rig_length_ft > 0 AND rv_max_rig_length_ft <= 120));
