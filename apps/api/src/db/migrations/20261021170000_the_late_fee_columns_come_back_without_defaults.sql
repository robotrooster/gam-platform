-- 10/19, late evening — PUTTING BACK WHAT I SHOULD NOT HAVE TAKEN.
--
-- Migration 20261020130000 dropped seven late-fee columns from `properties` on
-- the strength of my claim that nothing read them. The deploy's test suite then
-- failed 17 tests across properties, esign and pm, because plenty still does:
-- fixtures insert those columns, and GET /api/properties/:id reads
-- late_fee_initial_amount and late_fee_initial_type to compute the state-law
-- warnings (checkLeaseAgainstStateLaw — the Nevada 5% cap check and its kin).
--
-- That is the THIRD time today I called something dead from an incomplete
-- search. The first was late_fee_enabled, which the policy resolver gates on.
-- The second was late_fee_grace_days, read by the sync_unit_delinquency()
-- trigger that fires on every write to payments — a subagent caught that one,
-- and applying the migration as written would have broken every rent payment
-- on the platform. This is the third, and it is the one that actually shipped
-- as far as the database.
--
-- What Nic actually asked for was never "drop the columns". It was: "We need to
-- have no defaults on the property settings. ... I never set $5 or $15 flat.
-- It's the leases are right ... I don't know how the $15 ever came to be."
-- (10/19). The offence was a schema DEFAULT of 15.00 inventing a late fee no
-- landlord chose. So the columns come back NULLABLE AND WITH NO DEFAULTS, which
-- is exactly his ask and nothing more: a new property now starts with nothing
-- in them instead of a figure somebody has to discover and undo.
--
-- The real policy is unaffected and always was: it lives in
-- property_unit_type_late_fees per unit type, gets stamped onto each lease when
-- it is drafted, and the late-fee engine reads the LEASE. Nic's $5/day at
-- Mountain View and Oak Park and Blu's $50 flat at Country Acres are all in
-- that table, untouched by any of this.
--
-- Nullable rather than NOT NULL on purpose: NULL is the honest value for "this
-- property has not been asked", and every reader already copes with it —
-- checkLeaseAgainstStateLaw takes nulls, and the policy resolver never looks
-- here at all. No backfill: restoring the $15 is the one thing this must not do.
--
-- STILL OPEN, and it is Nic's call, not mine: the state-law warning on the
-- property page now has nothing to warn about, because nothing ever writes
-- these columns. It should almost certainly read the per-unit-type policy
-- instead, which is where a real late fee lives. That is a behaviour change to
-- a legal-adjacent check, so it waits for him rather than going in at midnight.
--
-- Safe drop: this migration only ADDS nullable columns. Reversing it means
-- dropping them again, and the comment above is the reason not to.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS late_fee_initial_amount numeric(10,2),
  ADD COLUMN IF NOT EXISTS late_fee_initial_type   text,
  ADD COLUMN IF NOT EXISTS late_fee_accrual_amount numeric(10,2),
  ADD COLUMN IF NOT EXISTS late_fee_accrual_type   text,
  ADD COLUMN IF NOT EXISTS late_fee_accrual_period text,
  ADD COLUMN IF NOT EXISTS late_fee_cap_amount     numeric(10,2),
  ADD COLUMN IF NOT EXISTS late_fee_cap_type       text;

COMMENT ON COLUMN properties.late_fee_initial_amount IS
  '10/19 (Nic): no default here, ever. A real late-fee policy lives in property_unit_type_late_fees per unit type and is stamped onto the lease; this is read only by the state-law warning on the property page and is NULL until somebody deliberately sets it.';
