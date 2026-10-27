-- A ceiling on how many FlexDeposit plans can be running at once.
-- (10/26, Nic, before turning the product on.)
--
--   "We have to be careful about how many people we can onboard on that at a
--    time. That needs to be scoped to some sort of capacity limit. So we don't
--    get freaking 500 people sign up tomorrow that we cannot realistically
--    [serve]. FlexDeposit is safer to roll out faster since we're not actually
--    fronting it to the landlord."
--
-- WHAT THE CEILING IS ABOUT.  Under the custody model GAM floats no principal,
-- so the exposure is not cash out the door — it is the UNFUNDED DEPOSIT each
-- plan represents. The landlord's books show the deposit satisfied at move-in
-- while the tenant is still paying it in; if the tenant stops, the landlord's
-- claim is only against what was collected, and the gap is a relationship GAM
-- has to manage, one conversation at a time. That is the thing that does not
-- scale to 500 overnight, which is why the cap counts PLANS and sums the
-- UNCOLLECTED amount rather than counting dollars fronted.
--
-- TWO LIMITS, EITHER OF WHICH CLOSES ENROLLMENT:
--   max_active_plans    — how many plans may be running at once, platform-wide.
--   max_uncollected     — the total still owed into custody across them.
-- NULL on either means that limit does not apply.
--
-- Deliberately PLATFORM-WIDE, not per landlord: the capacity being protected is
-- GAM's, so one busy park must not be able to consume it.
--
-- Starting values are small on purpose — one onboarding tomorrow, then raise it
-- by hand once the first few run clean. A super_admin changes these; there is no
-- self-service path, and no code reads a hardcoded number.
--
-- No backfill needed: there are zero FlexDeposit plans today.

CREATE TABLE IF NOT EXISTS flexdeposit_capacity (
  id                 BOOLEAN PRIMARY KEY DEFAULT TRUE,
  max_active_plans   INTEGER,
  max_uncollected    NUMERIC(12,2),
  note               TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         UUID REFERENCES users(id),
  -- One row, forever: a second row would make "the limit" ambiguous and let a
  -- stale one silently win.
  CONSTRAINT flexdeposit_capacity_one_row CHECK (id IS TRUE),
  CONSTRAINT flexdeposit_capacity_sane CHECK (
    (max_active_plans IS NULL OR max_active_plans >= 0)
    AND (max_uncollected IS NULL OR max_uncollected >= 0))
);

INSERT INTO flexdeposit_capacity (id, max_active_plans, max_uncollected, note)
SELECT TRUE, 10, 15000.00,
       'Opening ceiling, 10/26 — deliberately small for the first onboardings; raise by hand once a few plans run clean.'
 WHERE NOT EXISTS (SELECT 1 FROM flexdeposit_capacity);

COMMENT ON TABLE flexdeposit_capacity IS
  'Platform-wide ceiling on concurrent FlexDeposit plans and total uncollected deposit (10/26, Nic). Either limit closes enrollment; NULL disables that limit. One row.';
