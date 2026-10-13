-- 10/12 (Nic) — A METER CONFIRMED WORKING WHEN NOBODY USES ANY POWER
--
--   "Gerald Logue (Mountain View RV 48): void his $22.47 estimated electric
--    and mark his meter working (zero use then bills $0). Mountain View's
--    estimate setting stays on."
--
-- Zero use on an occupied space is read as a stuck meter (services/
-- utilityBilling: the cycle read equals the read before it, over at least a
-- day, while somebody lived there). Putting the meter back in service
-- (services/meterRepair) records a fresh starting read, but the next flat read
-- is measured from it, so a tenant who genuinely uses nothing was flagged
-- broken again every month — and at a property that estimates stuck meters
-- (Mountain View) billed another estimate each time.
--
-- zero_use_confirmed_at records that somebody confirmed the meter WORKS and
-- the household on it uses nothing. While it is set, a flat read is taken at
-- its word (usage 0, billed $0 — no line) instead of being called stuck, on
-- the monthly run and at signing alike. It stops counting:
--   - when a later cycle read shows usage (the meter moves: the confirmation
--     has done its job and is cleared),
--   - when somebody marks the meter broken by hand (cleared),
--   - when the household it was confirmed for leaves: a move-out or stay
--     turnover read on the meter after it (read at billing time).
--
-- Set by services/meterRepair when the repair says so (the one-time repair of
-- Gerald's meter, scripts/oct12_gerald_meter). No backfill needed: NULL is
-- today's behavior for every meter.
-- Safe drop: ALTER TABLE utility_meters DROP COLUMN zero_use_confirmed_at.

ALTER TABLE utility_meters ADD COLUMN IF NOT EXISTS zero_use_confirmed_at timestamptz;

COMMENT ON COLUMN utility_meters.zero_use_confirmed_at IS
  '10/12 (Nic): when somebody confirmed this meter works and the household on it uses nothing. While set (and no move-out or stay-turnover read has been taken since), a flat read on an occupied space bills $0 instead of being marked stuck. Cleared when a later cycle read shows usage or the meter is marked broken by hand.';
