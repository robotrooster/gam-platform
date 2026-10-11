-- S642 (Nic): "What do we do for distinguishing between units that are
-- physically not there?… how do we distinguish… that they are indeed below the
-- 25 unit threshold."
--
-- The previous migration made Illinois mobile-home parks count 'occupied_of_type'
-- instead of every unit row. Better, still wrong: it misses the case that
-- actually decides the gate.
--
--   tenant living in their own home        occupied → counted ✓
--   PARK-OWNED HOME SITTING EMPTY          vacant   → NOT counted ✗ WRONG
--   tenant towed their home away           vacant   → not counted ✓ by luck
--   bare slab that never had a home        vacant   → not counted ✓ by luck
--
-- 765 ILCS 745/18(b) counts a park "regularly containing 25 or more MOBILE
-- HOMES". A park-owned home standing empty on its space is a mobile home the
-- park regularly contains. Occupancy is not the question; presence is.
--
-- The right noun already exists: the mobile_homes table — one row per physical
-- home, unit_id for the space it sits on, removed_at for when it leaves, plus
-- serial and HUD label the park needs for titling anyway. 'homes_present'
-- counts those.
--
-- DELIBERATELY NOT A UNIT STATUS. Status is the tenancy state (vacant, active,
-- delinquent). "Is a dwelling physically here" is a different axis, and a park
-- space is the only place the two come apart — an uninhabitable APARTMENT is
-- still a unit the building contains, because 765 ILCS 715/1 counts "units",
-- not habitable ones. Folding both onto status would make one value mean
-- different things per unit type, which is precisely the confusion this fixes.
ALTER TABLE state_deposit_interest_rates
  DROP CONSTRAINT IF EXISTS state_deposit_interest_rates_min_units_basis_check;

ALTER TABLE state_deposit_interest_rates
  ADD CONSTRAINT state_deposit_interest_rates_min_units_basis_check
  CHECK (min_units_basis IN ('all_units', 'occupied_of_type', 'homes_present'));

UPDATE state_deposit_interest_rates
   SET min_units_basis = 'homes_present'
 WHERE min_units_basis = 'occupied_of_type';

COMMENT ON COLUMN state_deposit_interest_rates.min_units_basis IS
  'What min_property_units counts. all_units = units that exist (765 ILCS 715/1 "25 or more units" — an uninhabitable apartment still counts). homes_present = rows in mobile_homes not yet removed (765 ILCS 745/18 "regularly containing 25 or more mobile homes" — a park-owned home standing empty still counts, a bare slab does not).';
