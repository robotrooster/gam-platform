-- S565: screening-service sales-tax catalog + registration gate.
--
-- GAM's renter-pool applicants buy their OWN portable FCRA consumer report
-- (a "screening service"). A handful of states tax info/screening services;
-- most do not. This is the same hard-compliance pattern as the S177 deposit-
-- interest / state-tax-form catalogs: GAM encodes the state-specific rule,
-- hardcoded, annual-refresh migration cadence. Research is done in-house
-- (no CPA yet) and every non-$0 row is marked status='research' — it must be
-- reconfirmed by a tax pro before it is trusted. Until then the *collection*
-- gate below keeps everything at $0 regardless of these rates.
--
-- TWO LAYERS (both required to actually charge tax):
--
--   1. state_screening_tax_rates — per-state, per-year: is a screening
--      service taxable here, and at what rate. The LEGAL FACT.
--
--   2. state_tax_registrations — has GAM actually registered to collect &
--      remit sales tax in this state? The OPERATIONAL GATE. Registered
--      nowhere yet → collects $0 everywhere today, zero risk. The nexus
--      monitor (S565, separate migration) flips this flag when GAM crosses
--      a state's economic-nexus threshold and Nic registers.
--
--   Collected tax = rate_pct × base  ONLY IF  (taxable AND registered).
--
-- Tax base = the SCREENING price line only (the Checkr pass-through cost the
-- applicant is charged for the report). NOT the GAM margin (that is a SaaS/
-- platform-service line, taxable only in the ~20 SaaS-taxing states — a
-- SEPARATE future map, not this catalog) and NOT card processing (a financial
-- service, untaxed). See CLAUDE.md gam-checkr-billing-model + S564 handoff.
--
-- THE load-bearing nuance: the pool charge is an *individual* buying their
-- *own* FCRA consumer report for *personal* use. Many info-services taxes are
-- business-use-only or exempt FCRA credit reports outright — generally
-- FAVORABLE to $0. This also makes determinations genuinely complex, which is
-- why the non-$0 states carry status='research' + Low/Med confidence notes.
--
-- Annual-refresh discipline (per CLAUDE.md S177): a NEW migration extends the
-- catalog with effective_year=NNNN rows. Never UPDATE a prior year's row.

CREATE TABLE state_screening_tax_rates (
  state_code       text    NOT NULL,
  effective_year   integer NOT NULL,
  taxable          boolean NOT NULL DEFAULT false,
  rate_pct         numeric(6,4) NOT NULL DEFAULT 0,   -- STATE base rate; local surtaxes not modeled (see notes)
  basis            text    NOT NULL DEFAULT 'screening',
  status           text    NOT NULL DEFAULT 'research',
  source           text,
  notes            text,
  created_at       timestamp with time zone NOT NULL DEFAULT NOW(),
  updated_at       timestamp with time zone NOT NULL DEFAULT NOW(),
  PRIMARY KEY (state_code, effective_year),
  CONSTRAINT sstr_state_check
    CHECK (state_code = upper(state_code) AND length(state_code) = 2),
  CONSTRAINT sstr_year_check
    CHECK (effective_year BETWEEN 2020 AND 2100),
  CONSTRAINT sstr_rate_check
    CHECK (rate_pct >= 0 AND rate_pct <= 100),
  CONSTRAINT sstr_basis_check
    CHECK (basis IN ('screening', 'screening_plus_gamfee', 'total')),
  CONSTRAINT sstr_status_check
    CHECK (status IN ('research', 'confirmed')),
  -- a $0/non-taxable row must not carry a rate; a taxable row must
  CONSTRAINT sstr_taxable_rate_coherent
    CHECK ((taxable = false AND rate_pct = 0) OR (taxable = true AND rate_pct > 0))
);

COMMENT ON TABLE state_screening_tax_rates IS
  'Per-state, per-year screening-service sales-tax catalog (S565). taxable+rate = the legal fact; actual collection is ALSO gated on state_tax_registrations.registered. Non-$0 rows are status=research until a tax pro confirms. Base = the screening price line only.';
COMMENT ON COLUMN state_screening_tax_rates.rate_pct IS
  'State base rate only. Local/county surtaxes (TX, SD, NM, HI county surcharge) are NOT modeled here — flagged in notes; add a local-rate layer only if a registered state needs it.';
COMMENT ON COLUMN state_screening_tax_rates.basis IS
  'What the rate multiplies: screening = the Checkr pass-through screening line only (default, per S564). screening_plus_gamfee / total reserved if a state proves to tax the full receipt.';

-- ── Registration gate (the operational switch that actually turns on collection) ──
CREATE TABLE state_tax_registrations (
  state_code       text    PRIMARY KEY,
  registered       boolean NOT NULL DEFAULT false,
  registered_date  date,
  source           text    NOT NULL DEFAULT 'manual',  -- manual | nexus_auto
  notes            text,
  created_at       timestamp with time zone NOT NULL DEFAULT NOW(),
  updated_at       timestamp with time zone NOT NULL DEFAULT NOW(),
  CONSTRAINT str_state_check
    CHECK (state_code = upper(state_code) AND length(state_code) = 2),
  CONSTRAINT str_source_check
    CHECK (source IN ('manual', 'nexus_auto'))
);

COMMENT ON TABLE state_tax_registrations IS
  'Per-state sales-tax registration status (S565). The gate the tax catalog reads: collection happens ONLY where registered=true. Empty/false everywhere at launch → $0 collected nationwide, zero risk. Flipped by admin (manual) or by the nexus monitor crossing a threshold.';

-- ── 2026 seed: all 50 states + DC ────────────────────────────────────────────
-- Research-grade (S564). Reconfirm every taxable=true row before collecting.
-- Confidence lives in notes. Default posture = $0 (screening not an enumerated
-- taxable service in "services-exempt-unless-listed" states).
INSERT INTO state_screening_tax_rates
  (state_code, effective_year, taxable, rate_pct, basis, status, source, notes) VALUES
  -- No state sales tax at all (confirmed $0)
  ('AK', 2026, false, 0,      'screening', 'confirmed', 'no state sales tax', 'No state-level sales tax (local sales taxes exist in some AK boroughs; not modeled — revisit only if AK volume + a local jurisdiction taxes services).'),
  ('DE', 2026, false, 0,      'screening', 'confirmed', 'no state sales tax', 'No sales tax.'),
  ('MT', 2026, false, 0,      'screening', 'confirmed', 'no state sales tax', 'No sales tax.'),
  ('NH', 2026, false, 0,      'screening', 'confirmed', 'no state sales tax', 'No sales tax.'),
  ('OR', 2026, false, 0,      'screening', 'confirmed', 'no state sales tax', 'No sales tax.'),
  -- Taxable (research grade — reconfirm before collecting)
  ('TX', 2026, true,  6.2500, 'screening', 'research', 'TX Tax Code / credit-reporting service', 'Med conf. TX taxes "credit reporting services"; info services taxed on 80% of base. +local up to ~2%. Reconfirm whether an individual buying their OWN FCRA report for personal use is a taxable credit-reporting service (statute targets reports furnished about a THIRD party).'),
  ('SD', 2026, true,  4.2000, 'screening', 'research', 'SD DOR — services broadly taxed', 'Med-High conf. SD taxes services broadly incl. info/employment services. State rate 4.2%. +local. Nexus-gated.'),
  ('HI', 2026, true,  4.0000, 'screening', 'research', 'HI GET', 'Med-High conf. GET reaches ~all services. 4.0% state (+0.5% Oahu county surcharge → 4.5% effective there; surcharge not modeled). GET is technically on the seller — pass-through convention. Nexus-gated.'),
  ('NM', 2026, true,  5.0000, 'screening', 'research', 'NM GRT', 'Med conf. GRT taxes most services. State rate ~5.0% (verify current year; NM has been stepping the rate down). Combined w/ local ~5-9%. Nexus-gated.'),
  ('CT', 2026, true,  6.3500, 'screening', 'research', 'CT DRS — info/credit services', 'Low conf. CT taxes some info & credit-reporting services (standard 6.35%; some data services at 1%). NEEDS DETERMINATION which bucket a personal FCRA report falls in.'),
  ('DC', 2026, true,  6.0000, 'screening', 'research', 'DC OTR — info services', 'Low conf. DC taxes information services (6%). NEEDS DETERMINATION for a personal FCRA report.'),
  ('WV', 2026, true,  6.0000, 'screening', 'research', 'WV — services broadly taxed', 'Low conf. WV taxes services unless exempt (6%). NEEDS DETERMINATION for a personal FCRA report.'),
  -- Likely $0 despite being an info-services taxer (FCRA carve-out)
  ('OH', 2026, false, 0,      'screening', 'research', 'OH R.C. 5739.01 — info services business-use only + FCRA exemption', 'Med conf. OH taxes info/data services only when for BUSINESS use, and exempts FCRA consumer credit reports. Personal pool purchase → likely $0. Reconfirm.'),
  -- Default posture: screening not an enumerated taxable service ($0, research)
  ('AL', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('AZ', 2026, false, 0, 'screening', 'research', 'AZ TPT — services-exempt-unless-listed', 'Screening not an enumerated TPT classification. High conf $0.'),
  ('AR', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('CA', 2026, false, 0, 'screening', 'research', 'CA — sales tax on tangible goods only', 'CA generally does not tax services. High conf $0.'),
  ('CO', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('FL', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'FL taxes few services; screening not listed.'),
  ('GA', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('ID', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('IL', 2026, false, 0, 'screening', 'research', 'IL — no general services tax', 'IL taxes tangible goods; screening not covered. High conf $0.'),
  ('IN', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('IA', 2026, false, 0, 'screening', 'research', 'IA — enumerated services', 'IA taxes enumerated services; screening/credit-report not clearly listed. Reconfirm.'),
  ('KS', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('KY', 2026, false, 0, 'screening', 'research', 'KY — expanded services list', 'KY expanded taxable services (2018/2022); screening/credit-report not clearly listed. Reconfirm.'),
  ('LA', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('ME', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('MD', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service (MD taxes some digital/data — reconfirm).'),
  ('MA', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('MI', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('MN', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('MS', 2026, false, 0, 'screening', 'research', 'MS — services broadly taxed', 'MS taxes many services; screening/credit-report not clearly listed. Reconfirm (possible taxable).'),
  ('MO', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('NE', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('NV', 2026, false, 0, 'screening', 'research', 'NV — sales tax on tangible goods only', 'NV does not tax services. High conf $0.'),
  ('NJ', 2026, false, 0, 'screening', 'research', 'NJ — enumerated services', 'NJ taxes enumerated services; info services taxable in some cases — reconfirm for personal FCRA report.'),
  ('NY', 2026, false, 0, 'screening', 'research', 'NY — information services (personal-report exclusion)', 'NY taxes information services BUT excludes reports "personal or individual in nature" not substantially incorporated into others — a personal FCRA report likely falls in the exclusion. Reconfirm; possible taxable.'),
  ('NC', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('ND', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('OK', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('PA', 2026, false, 0, 'screening', 'research', 'PA — enumerated services', 'PA taxes enumerated services incl. some info services; "credit reporting" reconfirm — possible taxable.'),
  ('RI', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('SC', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('TN', 2026, false, 0, 'screening', 'research', 'TN — some services taxed', 'TN taxes specified services; screening/credit-report not clearly listed. Reconfirm.'),
  ('UT', 2026, false, 0, 'screening', 'research', 'UT — services-exempt-unless-listed', 'Screening not an enumerated taxable service. High conf $0.'),
  ('VT', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('VA', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('WA', 2026, false, 0, 'screening', 'research', 'WA — B&O vs retail sales tax', 'WA retail sales tax generally does not reach a personal FCRA report; WA B&O is a seller gross-receipts tax (not collected from the applicant). $0 to applicant; B&O is a GAM cost. Reconfirm.'),
  ('WI', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.'),
  ('WY', 2026, false, 0, 'screening', 'research', 'services-exempt-unless-listed', 'Screening not an enumerated taxable service.');
