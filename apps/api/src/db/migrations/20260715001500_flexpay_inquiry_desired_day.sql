-- S542c: FlexPay queue re-ordered by FLOAT NEED (Nic).
--
-- WHY: shorter float recycles bankroll faster — "we can float 3
-- people for one week each with the money one 3-week float ties up",
-- and longer floats earn the platform less per dollar-day. So the
-- queue orders by estimated float days ASC (front at lease grace-end
-- → tenant's benefit-arrival day), FIFO created_at as tiebreak.
-- Tenants NEVER see a queue number (no promises) — ordering is
-- admin-side only.
--
-- desired_pull_day = the day the tenant says their benefit arrives,
-- captured at inquiry (modal) or questionnaire. NULL = unknown
-- (funneled without a day) → sorted last until known.
--
-- No backfill needed (existing inquiries get NULL = end of queue
-- until the tenant or admin supplies the day).

ALTER TABLE flexpay_inquiries
  ADD COLUMN desired_pull_day int
  CHECK (desired_pull_day IS NULL OR (desired_pull_day >= 1 AND desired_pull_day <= 28));
