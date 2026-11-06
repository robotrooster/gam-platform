-- 10/31 (Nic) — A KNOWN HEAVY USER IS NOT A SUSPICIOUS READING.
--
--   "if she was billed that, we need a system to mark when people are just
--    generally high users. That way it doesn't flag the system every month."
--
-- The suspicious-usage guard compares a cycle's usage against ONE flat number
-- per utility type (METER_USAGE_ALERT_THRESHOLDS: 10,000 gallons of water,
-- 5,000 kWh, 1,000 therms) and never against the household's own history. So a
-- home that genuinely runs heavy trips it EVERY month, forever, and holds the
-- park's billing every time.
--
-- Country Acres Lot 17 is the case. It billed 19,800 gallons in September,
-- $326.70, paid and settled. October came in at 12,700 gallons — 7,100 gallons
-- LESS — and that is the month that got held, because the comparison moved to
-- billing units on 10/20 and 12,700 crossed a line 19,800 had slipped under
-- when it was measured in raw dial turns.
--
-- This mark says the landlord has looked and the usage is real for that
-- household. The guard then leaves that meter alone. It does NOT change what
-- the meter bills, it does not estimate, and it does not touch any other check:
-- a dial that goes backwards, a meter that stops moving on an occupied space,
-- and a RUBS master's typo guard all still apply. The mark is on the METER
-- rather than the household because the meter is what the reading belongs to,
-- and it is cleared by hand (not automatically) — a heavy user staying heavy is
-- the normal case, and GAM guessing that they stopped would put the monthly
-- hold straight back.
--
-- No backfill needed: absent = not marked, which is exactly today's behavior.

ALTER TABLE utility_meters
  ADD COLUMN IF NOT EXISTS high_use_confirmed_at         timestamptz,
  ADD COLUMN IF NOT EXISTS high_use_confirmed_by_user_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS high_use_note                 text;

COMMENT ON COLUMN utility_meters.high_use_confirmed_at IS
  '10/31: the landlord confirmed this household genuinely uses a lot, so the flat suspicious-usage threshold (METER_USAGE_ALERT_THRESHOLDS) stops holding its reads. Changes nothing about what the meter bills; the backwards-dial and stopped-meter checks still apply. Cleared by hand only.';

COMMENT ON COLUMN utility_meters.high_use_note IS
  '10/31: why the landlord marked it a heavy user, in their own words (big household, irrigation, a shop on the line). Shown beside the mark so a later reader knows what was checked.';
