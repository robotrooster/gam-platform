-- No-double-bill onboarding grace (Nic, S600).
--
-- WHY: to convert on-the-fence switchers, GAM sets up a landlord's whole
-- portfolio for free and does NOT charge the per-occupied-unit platform fee
-- until they actually GO LIVE — the first rent settled through GAM (they're
-- operating) — OR a bounded grace cap, whichever comes first. A landlord in
-- transition from another platform therefore never pays two platforms for the
-- same month. Setup + preview is free; operating is billed.
--
-- The grace cap is counted in BILLING CYCLES, not floating days, so it can never
-- bleed into a third free cycle regardless of signup date (see
-- PLATFORM_FEE_GRACE_CYCLES in packages/shared). Public marketing states the
-- PRINCIPLE only, never a day/cycle number.
--
-- TWO nullable columns on landlords:
--   * billing_starts_at  — the first billing cycle (first-of-month) from which
--     platformFeeAccrual bills this landlord. NULL = not yet billing (in grace /
--     pre-activation). Set to the CURRENT cycle on first settled rent, or to the
--     grace cap by the daily grace-cap cron, whichever fires first.
--   * billing_grace_until — the cap cycle (first-of-month) at which billing must
--     begin if the landlord never activates. Set at signup to
--     first-of-month(signup) + PLATFORM_FEE_GRACE_CYCLES months. Overridable by
--     superadmin when a large-portfolio setup runs long. NULL falls back (in the
--     cron) to first-of-month(created_at) + 2 months.
--
-- BACKFILL: every EXISTING landlord is already operating, so we set
-- billing_starts_at = their created month — they keep billing EXACTLY as today,
-- no retroactive free grace. billing_grace_until stays NULL for them (moot: the
-- cron only touches rows whose billing_starts_at IS NULL). Only landlords created
-- AFTER this migration (with the app-code that sets billing_grace_until) get the
-- grace behaviour.
--
-- Safe drop: both columns are nullable, no data loss on down.

ALTER TABLE landlords
  ADD COLUMN billing_starts_at  date,
  ADD COLUMN billing_grace_until date;

COMMENT ON COLUMN landlords.billing_starts_at IS
  'First billing cycle (first-of-month) platformFeeAccrual bills this landlord. NULL = in onboarding grace / not yet activated (no platform fee). Set to the current cycle on first settled rent (operating), or to the grace cap by the daily grace-cap cron. See PLATFORM_FEE_GRACE_CYCLES.';

COMMENT ON COLUMN landlords.billing_grace_until IS
  'Cap cycle (first-of-month) at which platform-fee billing must begin if the landlord never activates. Set at signup to first-of-month(signup) + PLATFORM_FEE_GRACE_CYCLES months; superadmin-overridable for long setups. NULL falls back to created_at + 2 months in the cron.';

-- Existing landlords keep billing unchanged: bill from the month they were created.
UPDATE landlords
   SET billing_starts_at = date_trunc('month', created_at)::date
 WHERE billing_starts_at IS NULL;
