-- S622: the onboarding migration window.
--
-- Nic: "during the migration period, existing tenants are obviously living
-- there beforehand and after the onboarding window is closed, all applicants
-- must complete the background check."
--
-- The first cut of the screening gate read "migrated" as a lease whose START
-- DATE precedes the landlord's onboarding. That is wrong, and Oak Park proves
-- it: the landlord onboarded 2026-08-14 and is now papering 30 existing
-- tenancies with NEW lease documents dated today. The tenancy is old; the
-- paperwork is new. Under that rule every one of his sitting tenants read as a
-- fresh applicant and the gate would have blocked his entire onboarding.
--
-- A WINDOW is what Nic actually described, and it is the honest model: for a
-- period after joining, a landlord is transcribing tenancies that already
-- exist. After it closes, everyone signing a new lease is an applicant.
--
-- 28 DAYS (raised from 21, Nic S623: "we never know when people are actually
-- gonna get around to finalizing all their details… maybe we should increase
-- the onboarding window to twenty eight days"). Originally 21, Nic's call: "during the onboarding window, the twenty one day grace
-- period that we set... they can sign a new e-signature lease without doing the
-- background check. After that, they have to do the background check."
--
-- Note this is NOT landlords.billing_grace_until, which is the no-double-bill
-- cap (two cycles, or first settled rent) and answers a different question. Two
-- separate windows because they protect different things: one is about when GAM
-- starts charging the landlord, this one is about when screening starts being
-- required of tenants. Collapsing them would tie a compliance rule to a pricing
-- rule.
--
-- It is a column, not a constant, so it can be extended for a large portfolio,
-- and closing it is a visible act rather than a silent expiry.

ALTER TABLE landlords
  ADD COLUMN IF NOT EXISTS migration_window_ends_at timestamptz;

-- Existing landlords get a window measured from when they joined.
UPDATE landlords
   SET migration_window_ends_at = created_at + INTERVAL '28 days'
 WHERE migration_window_ends_at IS NULL;
