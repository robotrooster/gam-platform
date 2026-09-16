-- S648 (Nic, DIRECTIVE): estimating a stuck meter is a temporary fix for ONE
-- property, not a platform feature.
--
--   "I do not want other properties, other landlords having the meter reads
--    guessed on. That's just for my property here. That needs to not be a
--    system feature. The way I want it to happen is flag if there's no change
--    in the meter and flag that it's broken. That will encourage landlords to
--    actually replace the meter. We're in the middle of upgrading stuff right
--    now, which is why I don't want to buy new meters for old pedestals when
--    we're replacing all the old pedestals. Other landlords can just do it the
--    right way or not bill the person for electricity. The estimated usage is
--    just for me at Mountain View, only at Mountain View, no other properties."
--
-- Deliberately NOT exposed by any route or screen. TRUE only for Mountain View
-- RV Ranch while its pedestals are replaced; everywhere else a meter that does
-- not move on an occupied space is marked out of service and bills nothing.
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS estimates_stuck_meters boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN properties.estimates_stuck_meters IS
  'S648: internal only, never landlord-settable. TRUE = a stuck or out-of-service submeter bills the low-end estimate from occupied neighbours (Nic''s stopgap at Mountain View during the pedestal replacement). FALSE = the meter is flagged broken and no utility bills until it is repaired.';

UPDATE properties SET estimates_stuck_meters = TRUE
 WHERE id = 'dcccb7b8-7ac9-4ec2-b3ff-40bde536df01';
