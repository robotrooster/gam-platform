-- 10/17 (Nic): "if that state's not counting some of those, where are we really
-- at? I'd rather count high and register with those states early."
--
-- Which of GAM's line items a state actually measures toward its economic-nexus
-- threshold is a question of that state's own law, and the published tables
-- disagree with each other: a gross-receipts state counts every dollar GAM
-- earns from a customer there, while a taxable-sales-only state counts just the
-- services it taxes. That is a researched legal fact per state, not a rule the
-- code can know, so it lives here as DATA — one row per state per year, with
-- one answer per line item.
--
-- SEEDED TO COUNT EVERYTHING, on purpose: the nexus page's headline number is
-- the combined total (count high, register early), and the rule only changes
-- what the "what this state would actually measure" subtotal says beside it. A
-- state with no row here counts everything too (the read COALESCEs to TRUE), so
-- a missing year can never quietly shrink a state's measure. Same reason every
-- column defaults TRUE: a line item added later is counted until somebody
-- researches otherwise.
--
-- Changing a rule never collects or stops collecting tax. Collection is gated
-- separately on state_tax_registrations.
CREATE TABLE IF NOT EXISTS state_nexus_measure_rules (
  state_code          text    NOT NULL,
  effective_year      integer NOT NULL,
  counts_subscription boolean NOT NULL DEFAULT TRUE,
  counts_markup       boolean NOT NULL DEFAULT TRUE,
  counts_screening    boolean NOT NULL DEFAULT TRUE,
  counts_optin        boolean NOT NULL DEFAULT TRUE,
  counts_other        boolean NOT NULL DEFAULT TRUE,
  source              text,
  notes               text,
  created_at          timestamp with time zone NOT NULL DEFAULT NOW(),
  updated_at          timestamp with time zone NOT NULL DEFAULT NOW(),
  PRIMARY KEY (state_code, effective_year),
  CONSTRAINT snmr_state_check
    CHECK (state_code = upper(state_code) AND length(state_code) = 2),
  CONSTRAINT snmr_year_check
    CHECK (effective_year BETWEEN 2020 AND 2100)
);

COMMENT ON TABLE state_nexus_measure_rules IS
  '10/17 (Nic): which of GAM''s revenue line items each state measures toward its economic-nexus threshold. Seeded to count everything — the law differs by state and the published tables disagree, so this is data a tax pro can correct without a code change. Never collects tax.';
COMMENT ON COLUMN state_nexus_measure_rules.counts_subscription IS 'Does this state count GAM''s platform subscription receipts toward its threshold?';
COMMENT ON COLUMN state_nexus_measure_rules.counts_markup IS 'Does this state count GAM''s card and bank payment markup toward its threshold?';
COMMENT ON COLUMN state_nexus_measure_rules.counts_screening IS 'Does this state count GAM''s screening margin toward its threshold?';
COMMENT ON COLUMN state_nexus_measure_rules.counts_optin IS 'Does this state count what customers pay for opt-in services (FlexPay, credit reporting) toward its threshold?';
COMMENT ON COLUMN state_nexus_measure_rules.counts_other IS 'Does this state count GAM''s remaining earnings (card-reader markup, placement fees, anything new) toward its threshold?';
COMMENT ON COLUMN state_nexus_measure_rules.source IS 'Where the answer came from — the state''s own publication, or the pro who confirmed it.';

-- Every state the threshold catalog already knows gets a row that counts
-- everything. Idempotent: re-running leaves researched answers alone.
INSERT INTO state_nexus_measure_rules (state_code, effective_year, source, notes)
SELECT t.state_code, t.effective_year, 'seed',
       'Seeded 10/17 to count every line item — count high, register early. Narrow it only on a researched answer.'
  FROM state_nexus_thresholds t
ON CONFLICT (state_code, effective_year) DO NOTHING;
