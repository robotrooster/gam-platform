-- 10/31 (Nic) — WHERE IN THE PARK A HOUSEHOLD SITS, FOR WHEN ITS METER DIES.
--
--   "I'd like a way to flag high usage people as billing kind of not the highest
--    in the park, but on the upper end of the spectrum... The RV zoos have 4
--    people in that RV, 2 young kids that I'm sure are just going crazy with
--    everything. There's a difference between that and a single person that's
--    working 12-hour shifts."
--
-- A broken submeter is estimated from the neighbours, and S647 fixed that at the
-- 25th percentile of credible occupied usage — "the low end of where people are
-- starting to cluster." That is the right default and it stays the default: it is
-- conservative, and three quarters of the park used more.
--
-- But it is one number for every household, and the landlord can see what GAM
-- cannot. A family of four home all day and a single person on twelve-hour
-- shifts do not belong at the same point in that spread. This lets the landlord
-- move the estimate to the median or the 75th percentile for a space they know
-- runs high.
--
-- 'upper' is the 75th percentile, NOT the maximum, on purpose: one heavy outlier
-- must never set somebody else's bill. The values mirror METER_USAGE_BANDS in
-- packages/shared.
--
-- Where the landlord knows the actual figure, expected_monthly_usage (migration
-- 20261031160000) beats this — a real number from their own records is better
-- than any percentile of their neighbours.
--
-- No backfill needed: the default 'low' is exactly today's behaviour.

ALTER TABLE utility_meters
  ADD COLUMN IF NOT EXISTS usage_band text NOT NULL DEFAULT 'low';

-- No ADD CONSTRAINT IF NOT EXISTS in Postgres; drop by name first so the file
-- replays cleanly. The values mirror METER_USAGE_BANDS in packages/shared.
ALTER TABLE utility_meters DROP CONSTRAINT IF EXISTS utility_meters_usage_band_check;
ALTER TABLE utility_meters
  ADD CONSTRAINT utility_meters_usage_band_check
    CHECK (usage_band IN ('low', 'typical', 'upper'));

COMMENT ON COLUMN utility_meters.usage_band IS
  '10/31: where in the neighbours usage a BROKEN meter is estimated — low = 25th percentile (default, S647), typical = median, upper = 75th percentile. Never the maximum. Ignored entirely while the meter reads, and beaten by expected_monthly_usage when that is set.';
