-- S616 (Nic) — mobile home spaces are not rented by the night.
--
--   "I don't know where you're getting the twenty nine out of thirty... that's
--    completely false. The apartment doesn't allow that, and all eight mobile
--    home spaces do not allow that. So we need to check something. If you're
--    thinking that it's set up that way, then we need to adjust the onboarding
--    flow because there's something that I missed."
--
-- He did not miss anything — the onboarding flow set it. Creating a unit
-- computed the allow-list as "nightly and weekly unless the type is short-stay
-- LOCKED", and the locked list contains exactly one type: storage. So every
-- mobile home, apartment, house and commercial space GAM has ever created came
-- out bookable by the night, silently, with no screen ever asking.
--
-- Editing a unit's type used a different rule in the same file — a matrix, with
-- anything unlisted falling back to long-term only. The two disagreed for every
-- type in neither list, so a unit's allow-list depended on which screen last
-- touched it. Both now call leaseTypesForUnitType in @gam/shared.
--
-- This corrects the units already created that way. Deliberately NOT a blanket
-- rewrite of every unit: an RV spot, campsite, hotel room, parking space, boat
-- slip or land lot is legitimately short-stay, and a landlord may have turned
-- one off on purpose. Only the four home-shaped types are corrected, and only
-- where nightly or weekly is present — the value nothing could have asked for.
UPDATE units
   SET lease_types_allowed = ARRAY['month_to_month','long_term'],
       is_bookable = FALSE,
       updated_at = NOW()
 WHERE unit_type IN ('apartment','single_family','mobile_home','commercial')
   AND lease_types_allowed && ARRAY['nightly','weekly'];
