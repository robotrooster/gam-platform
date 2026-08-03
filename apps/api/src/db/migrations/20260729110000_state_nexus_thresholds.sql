-- S565: economic-nexus threshold catalog (the "when must GAM register" table).
--
-- Post-Wayfair, every sales-tax state imposes an ECONOMIC NEXUS threshold: once
-- a remote seller's sales into the state exceed $X (and/or N transactions) in
-- the measurement period, the seller must register to collect & remit. This
-- catalog holds those per-state thresholds. The nightly nexus tally (S565,
-- services/nexusMonitor.ts) compares GAM's own revenue-by-customer-state against
-- these numbers and lights up the admin dashboard.
--
-- ⚠️ MONITORING (this table + the tally) is a TRIGGER, not a charge. Crossing a
-- threshold PROMPTS Nic to register; it does NOT itself collect a cent. Actual
-- collection stays gated on state_tax_registrations.registered (S565 tax
-- migration). Nic's S564 decision: count ALL of GAM's OWN revenue conservatively
-- so we register EARLY (registering early is harmless; registering late = back
-- tax + penalties).
--
-- Research-grade. The REVENUE figures are the well-established Wayfair-era
-- numbers (stable, high confidence). The TRANSACTION-COUNT test varies and many
-- states have REPEALED it (revenue-only now) — txn_threshold is nullable and
-- carries lower confidence; reconfirm before treating a txn-count crossing as
-- binding. A tax pro should confirm the whole catalog before first registration.
--
-- Annual-refresh: extend with effective_year=NNNN rows; never mutate a prior row.

CREATE TABLE state_nexus_thresholds (
  state_code             text    NOT NULL,
  effective_year         integer NOT NULL,
  revenue_threshold_usd  numeric(12,2),          -- NULL = no sales tax / no economic-nexus regime (never register)
  txn_threshold          integer,                -- NULL = revenue-only (state has no / repealed the count test)
  count_rule             text    NOT NULL DEFAULT 'or',  -- how revenue & txn combine: 'or' | 'and' | 'revenue_only'
  measurement_period     text    NOT NULL DEFAULT 'prior_or_current_calendar_year',
  status                 text    NOT NULL DEFAULT 'research',
  source                 text,
  notes                  text,
  created_at             timestamp with time zone NOT NULL DEFAULT NOW(),
  updated_at             timestamp with time zone NOT NULL DEFAULT NOW(),
  PRIMARY KEY (state_code, effective_year),
  CONSTRAINT snt_state_check
    CHECK (state_code = upper(state_code) AND length(state_code) = 2),
  CONSTRAINT snt_year_check
    CHECK (effective_year BETWEEN 2020 AND 2100),
  CONSTRAINT snt_revenue_check
    CHECK (revenue_threshold_usd IS NULL OR revenue_threshold_usd > 0),
  CONSTRAINT snt_txn_check
    CHECK (txn_threshold IS NULL OR txn_threshold > 0),
  CONSTRAINT snt_count_rule_check
    CHECK (count_rule IN ('or', 'and', 'revenue_only')),
  CONSTRAINT snt_status_check
    CHECK (status IN ('research', 'confirmed'))
);

COMMENT ON TABLE state_nexus_thresholds IS
  'Per-state, per-year economic-nexus registration thresholds (S565). Compared against GAM own-revenue-by-customer-state by the nightly nexus tally. A crossing PROMPTS registration; it does not collect tax (collection = state_tax_registrations). Revenue figures high-confidence; txn-count research-grade.';
COMMENT ON COLUMN state_nexus_thresholds.count_rule IS
  'or = either threshold triggers (classic Wayfair). and = both required (NY). revenue_only = txn count ignored / repealed.';
COMMENT ON COLUMN state_nexus_thresholds.revenue_threshold_usd IS
  'NULL for the no-sales-tax states (DE, MT, NH, OR) — GAM never registers there. AK has no STATE tax but a statewide LOCAL commission (ARSSTC) with a $100k threshold, seeded as such.';

-- ── 2026 seed: all 50 states + DC ────────────────────────────────────────────
INSERT INTO state_nexus_thresholds
  (state_code, effective_year, revenue_threshold_usd, txn_threshold, count_rule, measurement_period, status, source, notes) VALUES
  -- No sales tax → no economic-nexus registration ever
  ('DE', 2026, NULL, NULL, 'revenue_only', 'n/a', 'confirmed', 'no state sales tax', 'No sales tax — never register.'),
  ('MT', 2026, NULL, NULL, 'revenue_only', 'n/a', 'confirmed', 'no state sales tax', 'No sales tax — never register.'),
  ('NH', 2026, NULL, NULL, 'revenue_only', 'n/a', 'confirmed', 'no state sales tax', 'No sales tax — never register.'),
  ('OR', 2026, NULL, NULL, 'revenue_only', 'n/a', 'confirmed', 'no state sales tax', 'No sales tax — never register (CAT is a separate biz tax, not sales).'),
  ('AK', 2026, 100000.00, NULL, 'revenue_only', 'prior_calendar_year', 'research', 'AK ARSSTC (statewide local)', 'No STATE sales tax; statewide local via ARSSTC, $100k threshold, txn-count test repealed 2024. Only relevant if AK localities in the ARSSTC tax the service.'),
  -- Higher revenue thresholds
  ('CA', 2026, 500000.00, NULL, 'revenue_only', 'prior_or_current_calendar_year', 'research', 'CA CDTFA', '$500k, no transaction count.'),
  ('TX', 2026, 500000.00, NULL, 'revenue_only', 'prior_12_months', 'research', 'TX Comptroller', '$500k total TX revenue over the preceding 12 calendar months; no txn count.'),
  ('NY', 2026, 500000.00, 100, 'and', 'prior_four_quarters', 'research', 'NY DTF', 'BOTH required: >$500k AND >100 sales in the prior four sales-tax quarters.'),
  ('AL', 2026, 250000.00, NULL, 'revenue_only', 'prior_calendar_year', 'research', 'AL DOR', '$250k, no txn count.'),
  ('MS', 2026, 250000.00, NULL, 'revenue_only', 'prior_12_months', 'research', 'MS DOR', '$250k, no txn count.'),
  -- Classic $100k OR 200 transactions
  ('AR', 2026, 100000.00, 200, 'or', 'prior_or_current_calendar_year', 'research', 'AR DFA', 'Classic $100k or 200 txns.'),
  ('CT', 2026, 100000.00, 200, 'and', 'prior_12_months', 'research', 'CT DRS', 'CT requires BOTH $100k AND 200 txns (12 months ending Sept 30).'),
  ('GA', 2026, 100000.00, 200, 'or', 'prior_or_current_calendar_year', 'research', 'GA DOR', 'Classic $100k or 200 txns.'),
  ('HI', 2026, 100000.00, 200, 'or', 'prior_or_current_calendar_year', 'research', 'HI DOT (GET)', '$100k or 200 txns.'),
  ('IL', 2026, 100000.00, 200, 'or', 'prior_12_months', 'research', 'IL DOR', '$100k or 200 txns.'),
  ('KY', 2026, 100000.00, 200, 'or', 'prior_or_current_calendar_year', 'research', 'KY DOR', 'Classic $100k or 200 txns.'),
  ('MD', 2026, 100000.00, 200, 'or', 'prior_or_current_calendar_year', 'research', 'MD Comptroller', 'Classic $100k or 200 txns.'),
  ('MI', 2026, 100000.00, 200, 'or', 'prior_calendar_year', 'research', 'MI Treasury', 'Classic $100k or 200 txns.'),
  ('MN', 2026, 100000.00, 200, 'or', 'prior_12_months', 'research', 'MN DOR', '$100k or 200 txns (MN: 10+ sales totaling $100k, or 200 txns).'),
  ('NE', 2026, 100000.00, 200, 'or', 'prior_or_current_calendar_year', 'research', 'NE DOR', 'Classic $100k or 200 txns.'),
  ('NV', 2026, 100000.00, 200, 'or', 'prior_or_current_calendar_year', 'research', 'NV DOT', 'Classic $100k or 200 txns.'),
  ('NJ', 2026, 100000.00, 200, 'or', 'prior_or_current_calendar_year', 'research', 'NJ Treasury', 'Classic $100k or 200 txns.'),
  ('NC', 2026, 100000.00, 200, 'or', 'prior_or_current_calendar_year', 'research', 'NC DOR', 'Classic $100k or 200 txns.'),
  ('OH', 2026, 100000.00, 200, 'or', 'prior_or_current_calendar_year', 'research', 'OH DOT', 'Classic $100k or 200 txns.'),
  ('OK', 2026, 100000.00, NULL, 'revenue_only', 'prior_or_current_calendar_year', 'research', 'OK Tax Comm', '$100k, no txn count.'),
  ('RI', 2026, 100000.00, 200, 'or', 'prior_calendar_year', 'research', 'RI Div of Tax', 'Classic $100k or 200 txns.'),
  ('SC', 2026, 100000.00, NULL, 'revenue_only', 'prior_or_current_calendar_year', 'research', 'SC DOR', '$100k, no txn count.'),
  ('SD', 2026, 100000.00, NULL, 'revenue_only', 'prior_or_current_calendar_year', 'research', 'SD DOR', '$100k; SD repealed its 200-txn test in 2023.'),
  ('UT', 2026, 100000.00, 200, 'or', 'prior_or_current_calendar_year', 'research', 'UT State Tax', 'Classic $100k or 200 txns.'),
  ('VT', 2026, 100000.00, 200, 'or', 'prior_12_months', 'research', 'VT Dept of Taxes', 'Classic $100k or 200 txns.'),
  ('VA', 2026, 100000.00, 200, 'or', 'prior_or_current_calendar_year', 'research', 'VA Tax', 'Classic $100k or 200 txns.'),
  ('WV', 2026, 100000.00, 200, 'or', 'prior_or_current_calendar_year', 'research', 'WV Tax Div', 'Classic $100k or 200 txns.'),
  ('DC', 2026, 100000.00, 200, 'or', 'prior_or_current_calendar_year', 'research', 'DC OTR', 'Classic $100k or 200 txns.'),
  -- $100k, transaction test repealed (revenue-only)
  ('AZ', 2026, 100000.00, NULL, 'revenue_only', 'prior_or_current_calendar_year', 'research', 'AZ DOR', '$100k; AZ has no transaction-count test.'),
  ('CO', 2026, 100000.00, NULL, 'revenue_only', 'prior_or_current_calendar_year', 'research', 'CO DOR', '$100k; CO repealed the 200-txn test.'),
  ('FL', 2026, 100000.00, NULL, 'revenue_only', 'prior_calendar_year', 'research', 'FL DOR', '$100k; no txn count.'),
  ('IA', 2026, 100000.00, NULL, 'revenue_only', 'prior_or_current_calendar_year', 'research', 'IA DOR', '$100k; IA repealed the 200-txn test.'),
  ('ID', 2026, 100000.00, NULL, 'revenue_only', 'prior_or_current_calendar_year', 'research', 'ID State Tax', '$100k; no txn count.'),
  ('IN', 2026, 100000.00, NULL, 'revenue_only', 'prior_or_current_calendar_year', 'research', 'IN DOR', '$100k; IN repealed the 200-txn test (2024).'),
  ('KS', 2026, 100000.00, NULL, 'revenue_only', 'prior_or_current_calendar_year', 'research', 'KS DOR', '$100k; no txn count.'),
  ('LA', 2026, 100000.00, NULL, 'revenue_only', 'prior_or_current_calendar_year', 'research', 'LA DOR', '$100k; LA repealed the 200-txn test (2023).'),
  ('ME', 2026, 100000.00, NULL, 'revenue_only', 'prior_or_current_calendar_year', 'research', 'ME Revenue', '$100k; ME repealed the 200-txn test.'),
  ('MA', 2026, 100000.00, NULL, 'revenue_only', 'prior_or_current_calendar_year', 'research', 'MA DOR', '$100k; no txn count.'),
  ('MO', 2026, 100000.00, NULL, 'revenue_only', 'prior_12_months', 'research', 'MO DOR', '$100k; no txn count.'),
  ('ND', 2026, 100000.00, NULL, 'revenue_only', 'prior_or_current_calendar_year', 'research', 'ND Tax', '$100k; ND repealed the 200-txn test.'),
  ('PA', 2026, 100000.00, NULL, 'revenue_only', 'prior_12_months', 'research', 'PA DOR', '$100k; no txn count.'),
  ('TN', 2026, 100000.00, NULL, 'revenue_only', 'prior_12_months', 'research', 'TN DOR', '$100k; TN repealed the 200-txn test.'),
  ('WI', 2026, 100000.00, NULL, 'revenue_only', 'prior_or_current_calendar_year', 'research', 'WI DOR', '$100k; WI repealed the 200-txn test.'),
  ('WY', 2026, 100000.00, NULL, 'revenue_only', 'prior_or_current_calendar_year', 'research', 'WY DOR', '$100k; WY repealed the 200-txn test (2024).'),
  ('WA', 2026, 100000.00, NULL, 'revenue_only', 'current_or_prior_calendar_year', 'research', 'WA DOR', '$100k cumulative gross receipts; no txn count.'),
  ('NM', 2026, 100000.00, NULL, 'revenue_only', 'prior_calendar_year', 'research', 'NM T&RD (GRT)', '$100k; gross receipts tax economic nexus, no txn count.');
