-- S604: stamp WHY an accrual happened, not just how much.
--
-- Migration 20260813120000 made the RATE CATALOG unit-type specific (Arizona
-- owes 5% on a mobile home under A.R.S. § 33-1431(B) and nothing on an
-- apartment under § 33-1321 or an RV space under § 33-2121), but the accrual
-- LOG had no unit-type dimension and the accrual JOB never passed a unit type
-- to the resolver. Consequence: the AZ row (unit_types = {mobile_home}) could
-- never match, so a mobile-home deposit accrued $0 — the exact obligation the
-- catalog was built to satisfy.
--
-- These columns record the resolution inputs alongside the output so a row is
-- self-explanatory years later, and so the annual statutory refresh can find
-- every row that was accrued under a superseded reading (act_key ties back to
-- state_law_section_texts).
--
-- Nullable + no backfill needed: the table has 0 rows (the job has never run).
-- Left nullable rather than NOT NULL DEFAULT so that a row written by an older
-- build is visibly un-stamped instead of silently claiming a unit type it
-- never resolved.

ALTER TABLE security_deposit_interest_accruals
  ADD COLUMN IF NOT EXISTS unit_type   text,
  ADD COLUMN IF NOT EXISTS act_key     text,
  ADD COLUMN IF NOT EXISTS rate_source text;

-- Mirrors ResolvedRate.source in services/depositInterest.ts.
ALTER TABLE security_deposit_interest_accruals
  DROP CONSTRAINT IF EXISTS sdi_accruals_rate_source_check;
ALTER TABLE security_deposit_interest_accruals
  ADD CONSTRAINT sdi_accruals_rate_source_check
  CHECK (rate_source IS NULL OR rate_source IN ('statutory', 'landlord_override'));

COMMENT ON COLUMN security_deposit_interest_accruals.unit_type IS
  'S604: units.unit_type at accrual time — the input that selected the rate row. Deposit interest is unit-type specific, not merely state specific.';
COMMENT ON COLUMN security_deposit_interest_accruals.act_key IS
  'S604: state_law_section_texts.act_key of the statute this rate was read from (e.g. mobile_home_park). NULL for landlord overrides and pre-S603 blanket rows.';
COMMENT ON COLUMN security_deposit_interest_accruals.rate_source IS
  'S604: statutory catalog vs per-landlord override — which source supplied annual_rate_pct.';
