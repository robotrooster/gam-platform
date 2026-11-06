-- 10/27 (Nic) — THE FLEXPAY COOLDOWN IS A LADDER, AND ITS CLOCK ONLY RUNS ON GAM.
--
-- Asked whether the 90-day lockout was really his rule (CLAUDE.md and the S658
-- handoff both record that it "was never his rule"), he said it is:
--
--   "I don't know what my actual rule is. That's what I thought it was. Like 90
--    days and getting current. They can't just get back in if they haven't paid
--    what they owe. 90 days is a cool-off period before they're re-invited for
--    the first time. After that, the time might be longer. 6 months the second
--    time and a year the third time."
--
-- So BOTH conditions hold — paid in full AND the cool-off elapsed — and the
-- cool-off grows: 90 days, then 6 months, then a year.
--
-- THE PART NO EXISTING COLUMN CAN EXPRESS:
--
--   "Doesn't matter if they change landlords. If they're 3 months into their
--    year-long cooldown and they switch landlords, that cooldown only counts
--    while they're on GAM. So if they leave GAM for 2 years, they need to be
--    back on GAM for the remaining 9 months."
--
-- The clock is TENANCY TIME ON THE PLATFORM, not wall-clock time. A stored
-- `flexpay_disqualified_until` timestamp cannot say that — it keeps ticking
-- while somebody is gone. So the cool-off is stored as a START plus a COUNT,
-- and the elapsed figure is computed from how much of the period since that
-- start the tenant actually held a lease here (services/flexpay.ts,
-- flexPayCooldown).
--
-- WHAT THIS REPLACES, DELIBERATELY: `flexpay_permanently_banned` (S578) makes a
-- SECOND lifetime default terminal with no cooldown ever clearing it. That
-- cannot coexist with a six-month second cool-off and a one-year third. The
-- ladder is the newer and far more explicit instruction, so the column stops
-- being read as terminal. It is NOT dropped — it is live data about real
-- people, and GAM keeps what was ever true (it becomes a plain record that a
-- second default happened).
--
-- NO BACKFILL NEEDED for the count: nobody has ever enrolled in FlexPay
-- (enrollment is closed, zero advances exist), so there is no default history
-- to reconstruct. Verified read-only against production before writing this.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS flexpay_default_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flexpay_cooldown_from timestamp with time zone;

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_flexpay_default_count_sane;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_flexpay_default_count_sane
    CHECK (flexpay_default_count >= 0);

-- A count without a start date cannot be measured, and a start date without a
-- count has no ladder rung to measure against. They travel together.
ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_flexpay_cooldown_paired;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_flexpay_cooldown_paired
    CHECK ((flexpay_default_count = 0) = (flexpay_cooldown_from IS NULL));

COMMENT ON COLUMN public.tenants.flexpay_default_count IS
  'How many times this tenant has defaulted on FlexPay. Picks the cool-off rung: '
  '1st = 90 days, 2nd = 6 months, 3rd and after = 1 year '
  '(FLEXPAY_COOLDOWN_ON_PLATFORM_DAYS in packages/shared). From the 2nd it also '
  'adds the re-entry surcharge to every price point.';

COMMENT ON COLUMN public.tenants.flexpay_cooldown_from IS
  'When the latest default happened. The cool-off is measured from here in '
  'TENANCY TIME ON GAM, not wall-clock: a tenant who leaves the platform stops '
  'the clock and resumes it when they come back (Nic 10/27). Computed by '
  'flexPayCooldown, never stored as an end date.';

COMMENT ON COLUMN public.tenants.flexpay_permanently_banned IS
  'DEPRECATED 10/27 and no longer read as terminal. S578 made a 2nd lifetime '
  'default permanent; Nic''s ladder gives a 2nd and 3rd chance behind longer '
  'cool-offs, so this is now only a record that it happened. Kept, not dropped: '
  'it is real history about real people.';
