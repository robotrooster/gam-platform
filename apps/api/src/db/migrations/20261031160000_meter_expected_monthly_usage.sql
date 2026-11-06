-- 10/31 (Nic) — WHAT THIS SPACE NORMALLY USES, FOR WHEN ITS METER DIES.
--
-- A broken submeter bills `lowestComparableUsage` — the low end of what
-- comparable occupied spaces used — where the property allows estimating. That
-- rule exists to protect a tenant from an inflated guess, and on most spaces it
-- is right. On a HEAVY user it does the opposite kind of damage.
--
-- Mountain View RV 39 is the case. Its dial stopped at 54100 and has jittered
-- within a hundred of that ever since (GAM has 54199, 54099, 54000, 54099 —
-- movements of -100, -99, +99). The household genuinely runs about 786 kWh a
-- month: from the landlord's own earlier reads, 50170 -> 50971 -> 51699 ->
-- 52536 -> 52885 -> 54100, which is 801, 728, 837, 349 and 1,215 kWh, mean 786
-- and median 801. The park's median those months was 115 and 166 kWh, with a
-- floor near zero. Estimating her off the park would have under-billed by
-- roughly $130 a month, every month, until somebody noticed.
--
-- GAM could not work her number out for itself, and that is the point: every
-- forward-looking read she has in GAM is one the landlord keyed by hand to force
-- the series upward, not a measurement. Her real history lived in his old
-- system. So the figure is the landlord's to state, once, and it is used only
-- while the meter cannot be read.
--
-- WHAT THIS IS NOT: a price, a minimum, or a floor under a working meter. A
-- meter that reads bills its own reads, always. This number is reached for only
-- on the broken-meter path, in place of the comparable estimate, and it is the
-- landlord's own figure for their own space — GAM never guesses it.
--
-- No backfill needed: absent = estimate from comparables, which is today's
-- behavior for every meter.

ALTER TABLE utility_meters
  ADD COLUMN IF NOT EXISTS expected_monthly_usage      numeric(12,2),
  ADD COLUMN IF NOT EXISTS expected_usage_set_at       timestamptz,
  ADD COLUMN IF NOT EXISTS expected_usage_set_by_user_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS expected_usage_note         text;

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, and every migration here has to
-- survive being applied twice (posPropaneProduct.test.ts replays the whole
-- chain). Dropping by name first is the idempotent form.
ALTER TABLE utility_meters DROP CONSTRAINT IF EXISTS utility_meters_expected_usage_positive;
ALTER TABLE utility_meters
  ADD CONSTRAINT utility_meters_expected_usage_positive
    CHECK (expected_monthly_usage IS NULL OR expected_monthly_usage > 0);

COMMENT ON COLUMN utility_meters.expected_monthly_usage IS
  '10/31: what this space normally uses in a month, in BILLING UNITS (the multiplier already applied), stated by the landlord. Used ONLY when the meter is broken and the property estimates, in place of lowestComparableUsage — a heavy user estimated off the park floor is badly under-billed. Never a minimum and never applied to a meter that reads.';

COMMENT ON COLUMN utility_meters.expected_usage_note IS
  '10/31: where the figure came from, in the landlord''s words, so a later reader can judge it.';
