-- S190: variable-rate state self-service for deposit interest.
--
-- S188 shipped the hardcoded rate catalog (state_deposit_interest_rates)
-- for fixed-rate statutory states (MA, MD, MN). Variable-rate states
-- (NY, NJ, CT, IL, PA, NH and others) require the landlord to look up
-- their bank's current passbook rate (or the state-published annual
-- rate) and enter it manually. This table is the per-landlord
-- per-state-year override.
--
-- Resolution order at accrual time:
--   1. state_deposit_interest_rates  (hardcoded statute) — wins if present
--   2. landlord_deposit_interest_rate_overrides — fallback for variable-rate
--   3. No rate → skip accrual
--
-- The hardcoded catalog wins because for fixed-rate states the rate
-- IS the statute; landlord can't override it lower (would expose
-- them to legal liability) and "higher" doesn't apply (the statute
-- is the floor and ceiling).
--
-- Side-effect of S188's FK from security_deposit_interest_accruals to
-- state_deposit_interest_rates: under the override pathway, the
-- accrual row's (state_code, effective_year) wouldn't match a
-- statutory-catalog row, breaking the FK. Drop it. The accrual row
-- still snapshots state_code + effective_year + annual_rate_pct as
-- columns; FK enforcement was defensive and is unnecessary now that
-- the source can be either catalog.

-- Drop the S188 FK so accrual rows can come from either source.
ALTER TABLE security_deposit_interest_accruals
  DROP CONSTRAINT security_deposit_interest_accruals_rate_match_fk;

CREATE TABLE landlord_deposit_interest_rate_overrides (
  id              uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  landlord_id     uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  state_code      text NOT NULL,
  effective_year  integer NOT NULL,
  annual_rate_pct numeric(6,4) NOT NULL,
  source_notes    text,
  created_at      timestamp with time zone NOT NULL DEFAULT NOW(),
  updated_at      timestamp with time zone NOT NULL DEFAULT NOW(),
  CONSTRAINT ldior_unique_landlord_state_year
    UNIQUE (landlord_id, state_code, effective_year),
  CONSTRAINT ldior_state_check
    CHECK (state_code = upper(state_code) AND length(state_code) = 2),
  CONSTRAINT ldior_year_check
    CHECK (effective_year BETWEEN 2020 AND 2100),
  CONSTRAINT ldior_rate_check
    CHECK (annual_rate_pct >= 0 AND annual_rate_pct <= 100)
);

CREATE INDEX idx_ldior_landlord_year
  ON landlord_deposit_interest_rate_overrides(landlord_id, effective_year);

COMMENT ON TABLE landlord_deposit_interest_rate_overrides IS
  'Per-landlord, per-state, per-year deposit interest rate. Falls back path when state_deposit_interest_rates has no row for the (state, year). Used for variable-rate statutory states (NY/NJ/CT/IL/PA/NH) where the rate depends on the landlord''s bank.';
COMMENT ON COLUMN landlord_deposit_interest_rate_overrides.source_notes IS
  'Free-text — landlord captures their bank name + current passbook rate, the state-published rate, or the date they verified it. Audit trail for "why this rate".';
