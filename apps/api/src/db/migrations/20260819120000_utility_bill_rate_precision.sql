-- S607: widen the rate snapshotted on a utility bill, numeric(10,4) → (14,6).
--
-- 4 decimal places was sized for a rate a human types — $0.0100 a gallon. A
-- BLENDED rate is not typed, it is derived: the provider's dollar bill divided
-- by the usage it covered, e.g. $1,284.50 ÷ 90,000 gal = $0.014272…, which
-- stored as 0.0143 and no longer reproduced the charge. A tenant checking
-- rate × usage against the amount would find it off by dollars, and on a bill
-- whose whole selling point is that it shows its work, that is the first thing
-- that starts a dispute.
--
-- 6 places brings the reconstruction inside a couple of cents. The CHARGE stays
-- the authoritative figure — computed at full precision before rounding to the
-- cent — and the rate remains a snapshot for the audit trail; a derived rate
-- can never reproduce an arbitrary dollars/usage pair exactly at any finite
-- precision. This just stops it being visibly wrong.
--
-- No backfill: widening a numeric preserves every existing value, and bills
-- already issued keep the exact rate they were issued at.

ALTER TABLE utility_bills
  ALTER COLUMN rate_per_unit TYPE numeric(14,6);

COMMENT ON COLUMN utility_bills.rate_per_unit IS
  'S607: the rate this bill was charged at, snapshotted so policy changes never rewrite an issued bill. 6dp because a blended rate (provider bill ÷ usage) is derived, not typed. charge_amount is authoritative.';
