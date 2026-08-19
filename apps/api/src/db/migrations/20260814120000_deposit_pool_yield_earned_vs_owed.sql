-- S604 (Nic): track EARNED vs OWED on held deposits, automated.
--
--   "owed is by statute. earned is by market. subtract the difference."
--
-- OWED is what the state obligates GAM to credit the tenant — already computed
-- per deposit per month from state_deposit_interest_rates (unit-type aware
-- since S603/S604).
--
-- EARNED is what the pooled principal actually yields in the market. GAM holds
-- new-tenant deposits in a segregated trust and puts the balance to work
-- (T-bills feed the FlexPay float), so the pool earns a market rate that is
-- INDEPENDENT of any statute.
--
-- SPREAD = earned − owed. It is deliberately SIGNED. Where the market pays more
-- than the statute requires, GAM keeps the difference; where a statute demands
-- more than the market yields — Arizona's mobile-home 5% against a 4% T-bill is
-- the live example, not a hypothetical — the spread is NEGATIVE and GAM funds
-- the shortfall. A model that clamped at zero would hide exactly the case worth
-- knowing about.
--
-- Both sides are computed by the same monthly job against the same
-- principal × days_held basis, so they are always comparable and neither
-- requires anyone to key in a number each month.

-- ── The market side of the pool ────────────────────────────────────────────
-- Same annual-refresh discipline as state_deposit_interest_rates (CLAUDE.md
-- S177 carve-out): rows are INSERTED for a new period, never UPDATED, so a
-- historical accrual can always be re-derived from the rate that was in force.
CREATE TABLE IF NOT EXISTS deposit_pool_yield_rates (
  effective_month   date          NOT NULL,   -- always day 1
  annual_rate_pct   numeric(6,4)  NOT NULL,
  source_label      text          NOT NULL,   -- e.g. '4-week T-bill', 'trust account APY'
  notes             text,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (effective_month),
  CONSTRAINT dpyr_month_check CHECK (EXTRACT(day FROM effective_month) = 1),
  CONSTRAINT dpyr_rate_check  CHECK (annual_rate_pct >= 0 AND annual_rate_pct <= 100)
);

COMMENT ON TABLE deposit_pool_yield_rates IS
  'S604: the market yield GAM actually earns on pooled deposit principal, by month. The EARNED side of earned-vs-owed; the statutory catalog is the OWED side. Insert a new row per period; never update a past one.';

-- ── The per-deposit, per-month record ──────────────────────────────────────
-- interest_amount is the OWED figure and keeps its name: it is what flows to
-- the tenant at move-out via security_deposits.interest_accrued, and renaming
-- it would silently change what depositReturn pays out.
ALTER TABLE security_deposit_interest_accruals
  ADD COLUMN IF NOT EXISTS earned_amount        numeric(10,4),
  ADD COLUMN IF NOT EXISTS spread_amount        numeric(10,4),
  ADD COLUMN IF NOT EXISTS market_rate_pct      numeric(6,4);

COMMENT ON COLUMN security_deposit_interest_accruals.interest_amount IS
  'OWED: statutory interest credited to the tenant for this month.';
COMMENT ON COLUMN security_deposit_interest_accruals.earned_amount IS
  'S604 EARNED: what this deposit''s principal yielded at the market rate for the same days_held. NULL when no market rate is on file for the month.';
COMMENT ON COLUMN security_deposit_interest_accruals.spread_amount IS
  'S604: earned_amount − interest_amount. SIGNED — negative means the statute obliges more than the pool earned and GAM funds the difference.';
COMMENT ON COLUMN security_deposit_interest_accruals.market_rate_pct IS
  'S604: the deposit_pool_yield_rates rate in force for the accrual month, stamped so a row stays re-derivable.';

-- Accruals are written per (deposit, month); reporting reads them per month
-- across the whole pool to see the aggregate spread.
CREATE INDEX IF NOT EXISTS idx_sdi_accruals_month_spread
  ON security_deposit_interest_accruals (accrual_month)
  WHERE spread_amount IS NOT NULL;
