-- 10/24 (Nic) — HOW LONG THE RIG IS, AND HOW LONG THE SITE IS.
--
--   "One thing that I think we're missing is being able to size campers. So
--    like I'm trying to make a reservation right now where somebody's got a 37
--    foot camper. They can't go in the small sites, right?"
--
-- The schedule already packs itself (services/scheduleCompression) and already
-- honours what a reservation needs — but only LAYOUT and AMP SERVICE, because
-- those were the only two requirements a booking could carry. Nothing described
-- how long a site is, so nothing stopped a 37-foot fifth wheel being re-sited
-- onto a 24-foot back-in overnight. The guest finds out on arrival morning,
-- which is the worst possible moment: the reveal has gone out and the booking is
-- pinned.
--
-- Two numbers, in FEET, and deliberately nothing cleverer:
--   units.rv_max_rig_length_ft      the longest rig this site takes
--   unit_bookings.rig_length_ft     how long their camper is
--
-- NULL means "not stated", on both sides, and a NULL never blocks anything —
-- Mountain View has no lengths set on any site today and must keep working
-- exactly as it does. The rule only bites when BOTH numbers are known and the
-- rig is longer than the site (packages/shared isRigTooLongForSite).
--
-- Feet, not metres, and an integer: a park measures sites in whole feet and
-- nobody books a 37.5-foot site.
--
-- No backfill. Every existing site and booking is NULL, which is today's
-- behaviour exactly.

ALTER TABLE units ADD COLUMN IF NOT EXISTS rv_max_rig_length_ft INTEGER;
COMMENT ON COLUMN units.rv_max_rig_length_ft IS
  '10/24: the longest rig (feet) this site takes. NULL = not stated, and never blocks.';
ALTER TABLE units DROP CONSTRAINT IF EXISTS units_rv_max_rig_length_sane;
ALTER TABLE units ADD CONSTRAINT units_rv_max_rig_length_sane
  CHECK (rv_max_rig_length_ft IS NULL OR (rv_max_rig_length_ft > 0 AND rv_max_rig_length_ft <= 120));

ALTER TABLE unit_bookings ADD COLUMN IF NOT EXISTS rig_length_ft INTEGER;
COMMENT ON COLUMN unit_bookings.rig_length_ft IS
  '10/24: how long the guest''s camper is (feet), asked at the counter and on the booking site. NULL = not stated.';
ALTER TABLE unit_bookings DROP CONSTRAINT IF EXISTS unit_bookings_rig_length_sane;
ALTER TABLE unit_bookings ADD CONSTRAINT unit_bookings_rig_length_sane
  CHECK (rig_length_ft IS NULL OR (rig_length_ft > 0 AND rig_length_ft <= 120));

-- Finding the sites that fit a rig is the question the availability search and
-- the compressor both ask, over and over, per property.
CREATE INDEX IF NOT EXISTS idx_units_rig_length ON units (property_id, rv_max_rig_length_ft)
  WHERE rv_max_rig_length_ft IS NOT NULL;
