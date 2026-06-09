-- S188: deposit interest accrual engine.
--
-- Per CLAUDE.md S177 carve-out (Nic-confirmed): for *hard regulatory
-- accommodation* — statutes that obligate the landlord to do something
-- specific where ignorance creates legal exposure — GAM encodes the
-- state-specific rule, hardcoded with annual-refresh migration cadence.
-- Deposit interest is one of the two named carve-outs ("many states
-- require landlords to pay interest on held tenant deposits at a
-- state-specific rate, accrued over the holding period").
--
-- Two new tables:
--
-- 1. state_deposit_interest_rates — per-state, per-effective-year rate
--    catalog. Annual-refresh migration cadence: a new migration
--    extends this catalog rather than mutating prior rows. Statute
--    citation + source URL captured so a future Claude session
--    auditing the rates can reproduce the research.
--
-- 2. security_deposit_interest_accruals — per-month, per-deposit
--    accrual log. UNIQUE(security_deposit_id, accrual_month) for
--    idempotency: the monthly cron re-running for the same month
--    must be a no-op. The interest_amount on each row is the
--    canonical record; the running total writes back to
--    security_deposits.interest_accrued (which already existed —
--    pre-staged column from initial schema).
--
-- States NOT in this catalog have no statutory deposit-interest
-- requirement under GAM's framing — the accrual job skips them.
-- States with variable / actual-interest-earned statutes (NY, NJ,
-- CT, IL, PA, NH) are intentionally excluded from this initial
-- catalog: variable rates require per-bank-account or per-year
-- lookup that doesn't fit the hardcoded model. Those states get
-- a separate landlord-self-service path later (TBD).
--
-- Initial seed: three fixed-rate states with clear statutory
-- citation. CLAUDE.md S177 says "annual-refresh"; the next
-- migration in this series adds 2027 rows (or amends 2026 if a
-- state changes their rate mid-year, via a corrective migration).

CREATE TABLE state_deposit_interest_rates (
  state_code        text    NOT NULL,
  effective_year    integer NOT NULL,
  annual_rate_pct   numeric(6,4) NOT NULL,
  statute_citation  text    NOT NULL,
  source_url        text,
  notes             text,
  created_at        timestamp with time zone NOT NULL DEFAULT NOW(),
  PRIMARY KEY (state_code, effective_year),
  CONSTRAINT state_deposit_interest_rates_state_check
    CHECK (state_code = upper(state_code) AND length(state_code) = 2),
  CONSTRAINT state_deposit_interest_rates_year_check
    CHECK (effective_year BETWEEN 2020 AND 2100),
  CONSTRAINT state_deposit_interest_rates_rate_check
    CHECK (annual_rate_pct >= 0 AND annual_rate_pct <= 100)
);

COMMENT ON TABLE state_deposit_interest_rates IS
  'Per-state, per-year deposit interest rate catalog. Annual-refresh migration cadence per CLAUDE.md S177 carve-out. States not listed have no statutory accrual requirement.';

CREATE TABLE security_deposit_interest_accruals (
  id                   uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  security_deposit_id  uuid NOT NULL REFERENCES security_deposits(id) ON DELETE CASCADE,
  lease_id             uuid NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  accrual_month        date NOT NULL,
  state_code           text NOT NULL,
  effective_year       integer NOT NULL,
  annual_rate_pct      numeric(6,4) NOT NULL,
  principal_amount     numeric(10,2) NOT NULL,
  days_held            integer NOT NULL,
  days_in_month        integer NOT NULL,
  interest_amount      numeric(10,4) NOT NULL,
  created_at           timestamp with time zone NOT NULL DEFAULT NOW(),
  CONSTRAINT security_deposit_interest_accruals_unique_month
    UNIQUE (security_deposit_id, accrual_month),
  CONSTRAINT security_deposit_interest_accruals_month_check
    CHECK (EXTRACT(DAY FROM accrual_month) = 1),
  CONSTRAINT security_deposit_interest_accruals_days_held_check
    CHECK (days_held >= 0 AND days_held <= days_in_month),
  CONSTRAINT security_deposit_interest_accruals_rate_match_fk
    FOREIGN KEY (state_code, effective_year)
    REFERENCES state_deposit_interest_rates(state_code, effective_year)
);

CREATE INDEX idx_sdi_accruals_deposit ON security_deposit_interest_accruals(security_deposit_id);
CREATE INDEX idx_sdi_accruals_month   ON security_deposit_interest_accruals(accrual_month);

COMMENT ON TABLE security_deposit_interest_accruals IS
  'Per-month, per-deposit interest accrual log. Idempotent via UNIQUE(security_deposit_id, accrual_month). The cumulative sum of interest_amount writes back to security_deposits.interest_accrued.';
COMMENT ON COLUMN security_deposit_interest_accruals.accrual_month IS
  'First day of the month being accrued for. CHECK constraint enforces day-1.';
COMMENT ON COLUMN security_deposit_interest_accruals.days_held IS
  'Number of days during accrual_month the deposit was held. Full month = days_in_month; partial first/last month is computed from collection date / disbursement date.';
COMMENT ON COLUMN security_deposit_interest_accruals.interest_amount IS
  'principal_amount * (annual_rate_pct / 100) * (days_held / 365). Stored at 4 decimal places for accuracy across many small accruals; rounded to 2 decimals at the cumulative writeback point.';

-- ── Initial seed: fixed-rate states with clear statutory citation ────────
--
-- These three are the cleanest fixed-rate cases as of 2026. The list
-- intentionally excludes variable-rate states (NY, NJ, CT, IL statewide,
-- PA, NH) — those require per-bank or per-year lookups outside the
-- hardcoded model.
--
-- Annual-refresh: a future migration extends to 2027 with the same
-- rates (or new ones if the legislature changes them). Don't UPDATE
-- existing rows; INSERT new effective_year rows.

INSERT INTO state_deposit_interest_rates
  (state_code, effective_year, annual_rate_pct, statute_citation, source_url, notes)
VALUES
  ('MA', 2026, 5.0000,
   'Mass. Gen. Laws Ch. 186 § 15B(2)(a)',
   NULL,
   'Annual rate of 5% required when landlord holds for 1+ year. Interest must be paid annually if tenant remains.'),
  ('MD', 2026, 1.5000,
   'Md. Code Ann., Real Prop. § 8-203(e)(1)',
   NULL,
   'Simple interest at 1.5% per year on deposits ≥ $50. Paid at termination of tenancy.'),
  ('MN', 2026, 1.0000,
   'Minn. Stat. § 504B.178',
   NULL,
   'Simple interest at 1% per year. Paid when deposit returned at end of tenancy.');
