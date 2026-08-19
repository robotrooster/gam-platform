-- S605 (Nic, DIRECTIVE): "make utility rates set at the property level. adding
-- each unit is redundant and possible discrimination."
--
-- Rates lived on the METER (utility_meters.rate_per_unit / base_fee /
-- sewer_rate_per_unit), and a submeter is per-unit — so the same water at the
-- same property could be billed at a different price to each tenant, set by
-- whoever typed the unit in. That is the exact shape of the risk S535 already
-- closed for late fees: identical terms for every tenant at a property, decided
-- once as POLICY rather than per person.
--
-- It was also pure redundancy. Every unit at Oak Park carries the same electric
-- rate, retyped 19 times, with 19 chances to fat-finger one of them.
--
-- Mirrors property_utility_tax_rates deliberately — same grain
-- (property, utility_type), same uniqueness — so the rate and the tax on it are
-- configured and reasoned about together.
--
-- PRECEDENCE: the property rate WINS wherever it is set. The meter columns stay
-- (they are the historical record of what a bill was calculated from, and
-- utility_bills already snapshots rate_per_unit per bill) but they stop being
-- the authority for new bills. Nothing is rewritten — an existing bill keeps
-- exactly the rate it was issued at.
--
-- BACKFILL: seed each property/utility from the rate its meters already agree
-- on. Where meters DISAGREE, seed nothing — that property must be set
-- deliberately rather than have one tenant's rate silently imposed on their
-- neighbours, which is the very thing this migration exists to prevent.

CREATE TABLE IF NOT EXISTS property_utility_rates (
  id                  uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  property_id         uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  utility_type        text NOT NULL,
  rate_per_unit       numeric(12,5),
  base_fee            numeric(12,2) NOT NULL DEFAULT 0,
  -- Sewer rides the water reading (S533): same reading, second rate.
  sewer_rate_per_unit numeric(12,5),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, utility_type)
);

COMMENT ON TABLE property_utility_rates IS
  'S605: utility pricing is PROPERTY policy, not per-unit. Every tenant at a property pays the same rate for the same utility. Overrides utility_meters rate columns for new bills.';

-- Backfill only where every meter of that utility at the property already
-- agrees; a property with conflicting rates is left for the landlord to decide.
INSERT INTO property_utility_rates (property_id, utility_type, rate_per_unit, base_fee, sewer_rate_per_unit)
SELECT m.property_id,
       m.utility_type,
       MIN(m.rate_per_unit),
       COALESCE(MIN(m.base_fee), 0),
       MIN(m.sewer_rate_per_unit)
  FROM utility_meters m
 WHERE m.rate_per_unit IS NOT NULL
 GROUP BY m.property_id, m.utility_type
HAVING COUNT(DISTINCT m.rate_per_unit) = 1
   AND COUNT(DISTINCT COALESCE(m.base_fee, 0)) = 1
   AND COUNT(DISTINCT COALESCE(m.sewer_rate_per_unit, -1)) = 1
ON CONFLICT (property_id, utility_type) DO NOTHING;
