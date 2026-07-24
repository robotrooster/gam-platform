-- S551 (Nic): per-state application/screening fee cap catalog.
--
-- WHY: the platform runs ONE screening package (essential) in all states for
-- anti-discrimination consistency. Some states cap what an APPLICANT may be
-- charged for application/screening fees (a few prohibit charging entirely).
-- Nic's model: the applicant pays min(platform screening fee, state cap) and
-- the landlord absorbs the remainder — the landlord's Checkr bill is
-- unchanged; GAM simply caps the applicant-side reimbursement charge.
--
-- S177 hard-compliance carve-out applies (statutes the landlord must comply
-- with → hardcoded per state, annual-refresh migrations, like
-- state_deposit_interest_rates). Rows are per (state, effective_year); the
-- resolver takes the newest row with effective_year <= current year. NO ROW
-- for a state = uncapped (the common case; AZ has no cap).
--
-- cap_amount is the TOTAL the applicant may be charged (processing fees
-- included — substance over form). fee_prohibited=TRUE means the applicant
-- pays nothing (cap_amount NULL in that case).
--
-- No backfill needed: table starts EMPTY on purpose — the 50-state research
-- pass seeds it in a dedicated migration once each cap is verified. Empty
-- catalog = today's behavior everywhere.

CREATE TABLE state_application_fee_caps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state          char(2) NOT NULL,
  effective_year int  NOT NULL,
  cap_amount     numeric(10,2),
  fee_prohibited boolean NOT NULL DEFAULT FALSE,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (state, effective_year),
  CHECK (fee_prohibited = FALSE OR cap_amount IS NULL),
  CHECK (cap_amount IS NULL OR cap_amount >= 0)
);
