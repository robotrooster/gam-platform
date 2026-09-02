-- S635 (Nic): ONE PROPERTY, TWO PRICES FOR THE SAME UTILITY — BY UNIT TYPE.
--
-- Nic, on Mountain View propane: "$2.25 is the price per gallon for mobile home
-- customers. $3.30 is the price per gallon at the dispenser pump. The mobile
-- home people get a cheaper rate because they get delivery in bulk through our
-- supplier, but we charge more when we have to take the time to fill tanks for
-- people. So RV people are $3.30 a gallon, or outside customers as well."
--
-- The table was UNIQUE on (property_id, utility_type) — exactly one rate per
-- utility per property — so a park that bulk-delivers to its mobile homes and
-- hand-fills its RV spots could not state both. That is not a Mountain View
-- quirk: bulk-delivered vs pump-dispensed is the ordinary shape of any park
-- carrying both unit types, and the cost to serve genuinely differs.
--
-- THIS DOES NOT REOPEN PER-UNIT PRICING, and the distinction matters. The rule
-- in services/utilityBilling.ts stands: a rate that could be edited per UNIT is
-- a mechanism for billing two identical units differently for the same service,
-- which is the shape of a discrimination claim. A rate per unit TYPE is the
-- opposite — every mobile home at this property pays the same price, every RV
-- spot pays the same price, and the difference between them is a real difference
-- in how the fuel is delivered. Same reasoning that already makes deposit
-- interest obligations unit-type specific.
--
-- NULL unit_type is the PROPERTY-WIDE rate: what every unit pays unless its type
-- has a rate of its own. Every existing row is NULL, so nothing changes shape
-- and no property acquires a second price by accident.
--
-- BACKFILL: none. Existing rows become the property-wide default, which is what
-- they already were.
ALTER TABLE property_utility_rates
  ADD COLUMN IF NOT EXISTS unit_type text;

-- NULLS NOT DISTINCT so there is exactly ONE property-wide row per utility, not
-- one per insert. Without it the old uniqueness is silently lost.
ALTER TABLE property_utility_rates
  DROP CONSTRAINT IF EXISTS property_utility_rates_property_id_utility_type_key;

DROP INDEX IF EXISTS property_utility_rates_property_utility_unit_type_key;
CREATE UNIQUE INDEX property_utility_rates_property_utility_unit_type_key
  ON property_utility_rates (property_id, utility_type, unit_type) NULLS NOT DISTINCT;
