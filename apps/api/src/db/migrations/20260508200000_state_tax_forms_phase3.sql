-- S205: state_tax_forms catalog phase 3 — NJ, NC, GA, MI.
--
-- Conservative expansion. Tax-form data carries real consequence
-- (landlord misses a filing because we labeled it wrong → penalty);
-- only adding forms where the form code, agency, and cadence are
-- well-documented enough that I'd stake "do not get this wrong"
-- on it. The other states on the carry-forward (OH, PA, VA, MA)
-- have form-code or cadence ambiguity that I want a second look
-- before encoding in the catalog.
--
-- Phase 4 candidates: OH (IT-941 W/H + JFS 20127 UI), PA (PA W-3
-- W/H + UC-2 UI — partial confidence), VA (FC-20 UI),
-- MA (M-941 W/H + 0500 UI). Bundle once verified.

INSERT INTO state_tax_forms
  (state_code, form_code, form_name, agency, agency_url, category, frequency, due_dates, applies_to, statute, notes, effective_year)
VALUES
  -- NEW JERSEY
  ('NJ', 'NJ-927', 'Employer''s Quarterly Report (Withholding + UI + SDI)',
   'NJ Division of Taxation',
   'https://www.state.nj.us/treasury/taxation/employer-withholding.shtml',
   'withholding', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'N.J.S.A. 54A:7-1, 43:21-7',
   'Combined return — state income tax withholding + UI + SDI in one filing. Paired with WR-30 wage detail.',
   2026),
  ('NJ', 'WR-30', 'Employer Wage Report',
   'NJ Department of Labor and Workforce Development',
   'https://www.nj.gov/labor/ea/employer/wage-reporting.shtml',
   'reconciliation', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'N.J.S.A. 43:21-14',
   'Per-employee wage detail filed alongside NJ-927.',
   2026),

  -- NORTH CAROLINA
  ('NC', 'NC-5', 'Quarterly Withholding Tax Return',
   'NC Department of Revenue',
   'https://www.ncdor.gov/taxes-forms/withholding-tax',
   'withholding', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'N.C. Gen. Stat. § 105-163.1',
   'For quarterly filers. Monthly / semi-weekly filers use NC-5P; annual recon is NC-3.',
   2026),
  ('NC', 'NCUI-101', 'Employer''s Quarterly Tax and Wage Report',
   'NC Division of Employment Security',
   'https://des.nc.gov/employers',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'N.C. Gen. Stat. § 96-9.15',
   'Combined UI tax + per-employee wage detail.',
   2026),

  -- GEORGIA
  ('GA', 'G-7Q', 'Quarterly Withholding Return',
   'GA Department of Revenue',
   'https://dor.georgia.gov/taxes/business-taxes/withholding-tax',
   'withholding', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'O.C.G.A. § 48-7-101',
   'For quarterly-payment filers. Higher-volume employers file G-7M (monthly) or G-7SW (semi-weekly).',
   2026),
  ('GA', 'DOL-4', 'Employer''s Quarterly Tax and Wage Report',
   'GA Department of Labor',
   'https://dol.georgia.gov/employer-tax-information',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'O.C.G.A. § 34-8-1',
   'Combined UI tax + wage reporting.',
   2026),

  -- MICHIGAN (UI only this round; W/H form codes deferred for verification)
  ('MI', 'UIA 1028', 'Employer''s Quarterly Wage/Tax Report',
   'MI Unemployment Insurance Agency',
   'https://www.michigan.gov/uia/employers',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 25"},{"label":"Q2","due":"Jul 25"},{"label":"Q3","due":"Oct 25"},{"label":"Q4","due":"Jan 25 (next year)"}]'::jsonb,
   'with_property_in_state',
   'MCL 421.13',
   'Note: MI uses 25th-of-month UI deadlines, not the 30/31st most other states use. Combined UI tax + wage detail.',
   2026);
