-- S642 (Nic, on his Mattoon IL park): "Mattoon I think is about a thirty space
-- park. But I think only twenty-one units physically occupy the space… when a
-- twenty-five mobile home space park is in question, does it count the actual
-- capacity that the park is licensed for, or what's actually there?"
--
-- The statute answers it. 765 ILCS 745/18(b): "A park owner of any park
-- REGULARLY CONTAINING 25 OR MORE MOBILE HOMES shall pay interest…" The count
-- is of mobile HOMES PRESENT — not spaces, not slabs, not licensed capacity.
-- Mattoon at ~21 homes on ~30 slabbed spaces is UNDER the gate.
--
-- Illinois' own residential act reads differently in the same breath: 765 ILCS
-- 715/1 covers "residential real property, CONTAINING 25 OR MORE UNITS". Units
-- that exist, occupancy irrelevant. A half-empty 30-unit building is over that
-- gate; a 30-space park with 21 homes is under the other one. Same state, same
-- number, different noun.
--
-- THE BUG THIS FIXES. depositInterest.ts counted `SELECT COUNT(*) FROM units
-- WHERE property_id = p.id` for every gate — every unit row, every type,
-- occupied or not. Once Mattoon's spaces are all configured that reads 30,
-- trips Illinois' 25, and GAM accrues interest Illinois does not require. Wrong
-- in the expensive direction: paying out money on a park the statute does not
-- reach, every month, silently.
--
-- min_units_basis says WHICH count a gate means:
--   'all_units'        — units that exist (default; IL residential, NY 6+family)
--   'occupied_of_type' — units of the deposit's own type that are OCCUPIED,
--                        i.e. homes actually there (IL mobile home parks)
ALTER TABLE state_deposit_interest_rates
  ADD COLUMN IF NOT EXISTS min_units_basis text NOT NULL DEFAULT 'all_units'
    CHECK (min_units_basis IN ('all_units', 'occupied_of_type'));

COMMENT ON COLUMN state_deposit_interest_rates.min_units_basis IS
  'What min_property_units counts. all_units = units that exist (765 ILCS 715/1 "25 or more units"). occupied_of_type = units of the deposit''s own type that are occupied (765 ILCS 745/18 "regularly containing 25 or more mobile homes").';

-- Illinois mobile home parks count HOMES PRESENT.
UPDATE state_deposit_interest_rates
   SET min_units_basis = 'occupied_of_type'
 WHERE state_code = 'IL' AND act_key = 'mobile_home_park';

-- Everything else keeps counting units that exist, which is what it meant all
-- along — including IL residential and NY's six-or-more-family dwellings.
