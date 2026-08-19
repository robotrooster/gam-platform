-- Deposit interest is UNIT-TYPE specific, not just state-specific (S603, Nic).
--
-- WHY: the catalog was keyed (state_code, effective_year) with ONE rate, which
-- cannot express what the statutes actually say. Arizona, from GAM's own 50-state
-- corpus (state_law_section_texts, 49,161 sections):
--
--   mobile_home_park  A.R.S. § 33-1431(B) — "The landlord shall pay not less than
--                     five per cent annual interest on any damage, security,
--                     cleaning or landscaping deposit ... either pay the interest
--                     annually or compound the interest annually."
--   residential       A.R.S. § 33-1321    — deposits/refunds, NO interest owed
--   rv_long_term      A.R.S. § 33-2121    — deposits, 14-day return, NO interest owed
--
-- One state, three unit types, two different obligations. Pre-S603 a single AZ row
-- would have been wrong for two of the three — and Oak Park (mobile home / RV) is
-- exactly the property type carrying the 5%, compounding. Arizona had no row at
-- all, so those deposits accrued nothing.
--
-- SHAPE: `unit_types` is an ARRAY, mirroring state_landlord_tenant_acts.unit_types,
-- because one statute governs several of GAM's unit types (a mobile-home-park act
-- covers mobile_home and often rv_spot). An EMPTY array means "every unit type in
-- this state not matched by a more specific row" — so a state with a single
-- blanket rule needs exactly one row, and resolution prefers the specific match.
--
-- `act_key` ties each row back to the corpus section it came from, so a future
-- annual refresh can re-read the statute text rather than trusting a copied number.
--
-- Existing MA/MD/MN rows are blanket rules → migrated to empty unit_types, which
-- preserves their current behaviour exactly.
--
-- Backfill: AZ mobile-home + RV rows are seeded below FROM the corpus citations.
-- No other state is touched; per-unit-type research for the remaining 47 is a
-- separate pass (see SESSION_603_HANDOFF §9).

ALTER TABLE state_deposit_interest_rates
  ADD COLUMN IF NOT EXISTS unit_types text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS act_key    text;

-- The old PK (state_code, effective_year) forbids a second row per state, which is
-- the entire point of this change. Replace it with a key that admits one row per
-- (state, year, unit-type set).
ALTER TABLE state_deposit_interest_rates
  DROP CONSTRAINT IF EXISTS state_deposit_interest_rates_pkey;

ALTER TABLE state_deposit_interest_rates
  ADD CONSTRAINT state_deposit_interest_rates_pkey
  PRIMARY KEY (state_code, effective_year, unit_types);

-- Resolution order (services/depositInterest.ts): a row whose unit_types CONTAINS
-- the unit's type wins; otherwise the blanket row (unit_types = '{}') applies;
-- otherwise the state owes nothing.
CREATE INDEX IF NOT EXISTS idx_sdir_state_year_units
  ON state_deposit_interest_rates (state_code, effective_year);

COMMENT ON COLUMN state_deposit_interest_rates.unit_types IS
  'GAM unit types this statutory rate governs. EMPTY = blanket rule for the state '
  '(applies to any unit type with no more specific row). A specific match always '
  'beats the blanket row.';
COMMENT ON COLUMN state_deposit_interest_rates.act_key IS
  'act_key in state_law_section_texts this rate was read from, so an annual refresh '
  'can re-read the statute rather than trust a copied number.';

-- ── Arizona, from the corpus ────────────────────────────────────────────────
-- Mobile homes: 5% annual, compounding permitted. Covers mobile_home; AZ's RV
-- long-term spaces are governed by a DIFFERENT act (33-2121) that owes no
-- interest, so rv_spot is deliberately NOT included here.
INSERT INTO state_deposit_interest_rates
  (state_code, effective_year, annual_rate_pct, statute_citation, source_url, notes, unit_types, act_key)
VALUES
  ('AZ', 2026, 5.0000, 'A.R.S. § 33-1431(B)',
   'https://www.azleg.gov/ars/33/01431.htm',
   'Mobile Home Parks Residential Landlord and Tenant Act. "Not less than five per cent annual interest" on any damage, security, cleaning or landscaping deposit; payable annually OR compounded annually. Does NOT apply to AZ residential (33-1321) or RV long-term spaces (33-2121), which owe no deposit interest.',
   ARRAY['mobile_home'], 'mobile_home_park')
ON CONFLICT (state_code, effective_year, unit_types) DO NOTHING;
