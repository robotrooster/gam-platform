-- S635 REVERT of 20260902003000_utility_rate_by_unit_type.sql. Built on a
-- misreading, removed the same session.
--
-- I read "$2.25 for mobile home customers, $3.30 at the dispenser pump" as one
-- utility with two prices by unit type. Nic: "This isn't technically two
-- different rates... propane is listed at a rate, not as a utility rate, but as
-- a per gallon price in the point of sale side of things. Nothing to do with
-- utilities for direct delivery to the unit. That's the distinction. Utilities
-- that are direct delivery to the unit are one price. Utilities... or items sold
-- at the front counter at point of sale is a different price completely."
--
-- So there is ONE propane utility rate — what it costs to have it delivered into
-- your tank — and the pump price is a RETAIL ITEM that happens to be the same
-- substance. They are different products sold through different systems, not two
-- tiers of one price. property_utility_rates goes back to one row per
-- (property, utility), which was right.
--
-- DROPPED RATHER THAN LEFT UNUSED, for the reason Nic gave when
-- users.active_landlord_id came out: "so it doesn't creep its way back in
-- accidentally." A nullable unit_type sitting on a PRICING table is an
-- invitation to price two classes of resident differently for the same
-- delivered utility — the exact thing the per-property rule in
-- services/utilityBilling.ts exists to prevent.
--
-- BACKFILL: none. The only non-null row ever written was the Mountain View
-- mobile_home row from this session, removed below with the column.
DROP INDEX IF EXISTS property_utility_rates_property_utility_unit_type_key;

DELETE FROM property_utility_rates WHERE unit_type IS NOT NULL;

ALTER TABLE property_utility_rates DROP COLUMN IF EXISTS unit_type;

ALTER TABLE property_utility_rates
  DROP CONSTRAINT IF EXISTS property_utility_rates_property_id_utility_type_key;
ALTER TABLE property_utility_rates
  ADD CONSTRAINT property_utility_rates_property_id_utility_type_key
  UNIQUE (property_id, utility_type);
