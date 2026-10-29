-- 10/19 (Nic): "We need to have no defaults on the property settings. ... I
-- never set $5 or $15 flat. It's the leases are right ... I don't know how the
-- $15 ever came to be. That's never been a previous late fee that we had."
--
-- He could not have set it: it was never a setting. properties.late_fee_* is
-- NOT NULL with the figures written into the SCHEMA as column defaults --
-- initial_amount 15.00, grace_days 5, initial_type 'flat', enabled true. Every
-- property row ever created was born asserting a $15 late fee nobody chose,
-- and all seven of his read exactly that.
--
-- TWO OF THEM ARE NOT DEAD, and this migration nearly dropped both. The first
-- I caught by reading the resolver; the SECOND I missed entirely, because I
-- grepped the TypeScript and concluded "nothing reads these columns" without
-- ever asking the DATABASE what reads them. Another agent found it. Writing it
-- down because the lesson is bigger than this file: a column is not dead until
-- the functions, triggers and views have been asked too, not just the app.
--
-- late_fee_grace_days is read by the live trigger function sync_unit_delinquency(),
-- which fires on EVERY WRITE TO payments:
--   GREATEST(COALESCE(l.late_fee_grace_days, pr.late_fee_grace_days, 5), 1)
-- 82 of the 83 active leases carry no grace of their own, so every one of them
-- reaches that property fallback. Dropping the column would have broken the
-- function, and with it every rent payment, charge and settlement on the
-- platform. It stays, and so does its default.
-- services/lateFeePolicy resolveLateFeePolicyForUnit opens with
--   SELECT u.unit_type, u.property_id, p.late_fee_enabled ...
--   if (!unit || !unit.late_fee_enabled) return null
-- so properties.late_fee_enabled is a live master switch: false there and NO
-- late-fee terms get stamped onto any new lease at that property. It stays.
-- Only the FIGURES NOBODY READS go -- the $15 initial amount, its type, and the
-- accrual and cap columns. The resolver takes all of those from the per-unit-type
-- row, no database function mentions them (checked against pg_proc and every
-- view, not just the app), and the $15 is the number Nic objected to.
--
-- The rest are DEAD. A real policy lives in property_unit_type_late_fees (per
-- unit type: mobile_home, rv_spot, apartment), gets stamped onto each lease
-- when it is drafted, and the late-fee engine reads the LEASE --
-- COALESCE(l.late_fee_*, sa.late_fee_*) in jobs/lateFees, where sa is a
-- utility service agreement. Verified at the time of writing: every consumer
-- (jobs/lateFees, routes/landlords, routes/tenantAutopay, routes/esign,
-- routes/utilityServiceAgreements) reads the lease or the agreement, never the
-- property. All 83 active leases carry their park's real terms (Mountain View
-- and Oak Park $0 + $5/day, Country Acres $50 flat capped at $50), and
-- Country Acres has charged $250 of $50 fees off it.
--
-- So this is pure removal of a lie. Nothing reads these columns, nothing
-- computes a charge from them, and no figure anywhere moves. What it buys is
-- that nobody -- including whoever reads the properties table next looking for
-- a late-fee policy, as I did today and told Nic the wrong thing -- can mistake
-- a schema default for something a landlord decided.
--
-- No separate DROP DEFAULT step: dropping a column takes its default with it,
-- and the two ALTERs that used to do it referenced columns this same file then
-- removed — so a second run failed on a column that was already gone. Caught by
-- double-applying to a scratch database, which is the whole point of doing that.
--
-- Safe drop: this IS the drop. To undo, re-add the columns NULLABLE and with no
-- defaults; do not restore the values, because they never meant anything. No
-- backfill: the real policy was never in here.
-- Contract step (expand-then-contract): there is NO writer to remove. Nothing
-- in the tree has ever written these columns -- the only late-fee write to
-- properties is onboarding_late_fee_waiver, a different and live setting. The
-- $15 came from the column default alone, which is why Nic had never seen it
-- and could not have set it. (An earlier draft of this comment blamed
-- db/seed.ts; that was wrong -- seed.ts writes LEASE terms, not property ones.)

-- late_fee_enabled and late_fee_grace_days keep their columns and their
-- defaults: one is the live switch, the other is read by sync_unit_delinquency()
-- for 82 of 83 active leases. Defaulting a new property to "late fees allowed"
-- with a 5-day grace is not a figure anybody gets charged -- the terms still have
-- to be set per unit type before a lease can be drafted at all
-- (assertLateFeeDecision).

ALTER TABLE properties
  DROP COLUMN IF EXISTS late_fee_initial_amount,
  DROP COLUMN IF EXISTS late_fee_initial_type,
  DROP COLUMN IF EXISTS late_fee_accrual_amount,
  DROP COLUMN IF EXISTS late_fee_accrual_type,
  DROP COLUMN IF EXISTS late_fee_accrual_period,
  DROP COLUMN IF EXISTS late_fee_cap_amount,
  DROP COLUMN IF EXISTS late_fee_cap_type;
