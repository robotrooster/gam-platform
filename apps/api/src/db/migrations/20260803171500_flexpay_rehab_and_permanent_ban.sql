-- FlexPay two-strike lifecycle + returner rehab clock (S578, Nic-locked).
--
-- The product is gated to permanent continuing-benefit recipients (Social
-- Security / disability / pension), so reliability is its whole basis. The
-- default lifecycle Nic locked:
--   * 1st default (pull + retry both fail): removed → "returner". 90-day
--     lockout is a FLOOR; re-entry also gated by the waitlist (returners sort
--     behind all first-timers). NOT permanent.
--   * 2nd tenancy (got back on): the returner mark clears ONLY after 12
--     consecutive on-time, FIRST-attempt pulls with ZERO retries. Any retry —
--     even one that then clears — resets the 12-count. A clearing retry does
--     NOT remove them; it just restarts rehab.
--   * 2nd default (pull + retry both fail during the 2nd tenancy) = PERMANENT
--     removal, never back on FlexPay.
--
-- These three columns carry the state the crons/webhooks maintain incrementally
-- (streak on each clean reconcile, ban on the 2nd default). Permanent-ban is
-- also derivable from COUNT(defaulted flexpay_advances) >= 2, but we latch a
-- flag so the enroll/eligibility gate is a single boolean read.
--
-- No backfill needed: existing tenants start clean (streak 0, not cleared, not
-- banned). Any tenant with a single historical default remains a demoted
-- returner via the existing EXISTS(defaulted advance) check until they earn the
-- 12-clean-pull clearance under the new logic.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS flexpay_clean_streak       INTEGER  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flexpay_returner_cleared   BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS flexpay_permanently_banned BOOLEAN  NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN tenants.flexpay_clean_streak IS
  'S578: consecutive on-time first-attempt (zero-retry) FlexPay pulls in the current tenancy. Reset to 0 on enroll, on any retry, and on default. At FLEXPAY_REHAB_CLEAN_PULLS (12) a returner''s mark clears.';
COMMENT ON COLUMN tenants.flexpay_returner_cleared IS
  'S578: TRUE once a returner has completed 12 clean pulls and shed the queue demotion (treated as a first-timer again for future re-entry).';
COMMENT ON COLUMN tenants.flexpay_permanently_banned IS
  'S578: TRUE after the 2nd lifetime FlexPay default. Terminal — blocks all future enrollment.';
