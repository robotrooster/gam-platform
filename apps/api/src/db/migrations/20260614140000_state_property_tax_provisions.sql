-- state_property_tax_provisions — STRUCTURED per-state property-tax facts that
-- power a near-term GAM property-tax feature (sits alongside the verbatim
-- property_tax statute text in state_law_section_texts).
--
-- WHY a new shape instead of reusing state_law_provisions: the landlord/tenant
-- provisions layer is a flat topic→single-number model, which does NOT fit
-- property tax. Property-tax facts are heterogeneous:
--   - exemptions are MULTI-parameter (age AND income AND benefit amount/kind),
--     and each state has SEVERAL exemption programs (homestead, senior,
--     veteran, disability, ag, school-relief…);
--   - assessment-appeal/grievance is a DATE or relative window + a review body;
--   - payment is an INSTALLMENT SCHEDULE + grace;
--   - delinquency is penalty/interest RATES + a redemption PERIOD.
-- So this table keeps the dated/sourced "headline" columns (the carve-out
-- discipline) and puts each topic's variable fields in a `params` jsonb.
--
-- JURISDICTION: property tax is largely COUNTY/MUNICIPAL. State STATUTE sets the
-- framework (exemption eligibility ceilings, the statutory grievance deadline,
-- redemption periods, penalty caps); the exact rates and many due dates are set
-- LOCALLY. jurisdiction_level defaults to 'state' (we catalog the statutory
-- framework). When a statutory fact only sets a ceiling/default that localities
-- vary, set params.locally_variable=true so the feature can say so honestly.
-- (county/municipal levels are reserved for a future local-rate layer.)
--
-- ANNUAL REFRESH (mirrors state_deposit_interest_rates / state_tax_forms, the
-- S177 carve-out): on a new tax year, INSERT new rows with effective_year=NNNN.
-- NEVER UPDATE an existing row — dated history is preserved.
--
-- topic / jurisdiction_level values are the single source of truth in
-- packages/shared (PROPERTY_TAX_TOPIC_VALUES / PROPERTY_TAX_JURISDICTION_LEVELS);
-- this CHECK must list the same sets. params shapes per topic are documented in
-- shared (PropertyTax*Params interfaces). subtype is free-text (exemption
-- programs are too varied per state for a fixed enum) — lowercase slug.
--
-- This is the sanctioned no-state-legal carve-out (sourced + dated + factual;
-- never advice). Posture identical to the landlord/tenant KB.

CREATE TABLE state_property_tax_provisions (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  state_code         text NOT NULL,
  jurisdiction_level text NOT NULL DEFAULT 'state',
  topic              text NOT NULL,
  subtype            text,                       -- exemption program slug (senior/homestead/veteran/…); null for non-exemption topics
  summary            text NOT NULL,              -- plain-language, factual restatement (hedged; never advice)
  params             jsonb NOT NULL DEFAULT '{}'::jsonb,  -- per-topic structured fields (see shared PropertyTax*Params)
  statute_citation   text,
  source_url         text,
  source_date        date NOT NULL,
  effective_year     integer NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sptp_state_check CHECK (state_code = upper(state_code) AND length(state_code) = 2),
  CONSTRAINT sptp_level_check CHECK (jurisdiction_level IN ('state', 'county', 'municipal')),
  CONSTRAINT sptp_topic_check CHECK (topic IN (
    'exemption', 'assessment', 'assessment_appeal', 'payment', 'delinquency_redemption'
  )),
  CONSTRAINT sptp_year_check CHECK (effective_year >= 2020 AND effective_year <= 2100)
);

-- One row per (state, level, topic, subtype, year). subtype is nullable, so use
-- COALESCE in the unique index (NULLs would otherwise be treated as distinct).
CREATE UNIQUE INDEX sptp_unique
  ON state_property_tax_provisions (state_code, jurisdiction_level, topic, COALESCE(subtype, ''), effective_year);

CREATE INDEX idx_sptp_lookup ON state_property_tax_provisions (state_code, topic);
