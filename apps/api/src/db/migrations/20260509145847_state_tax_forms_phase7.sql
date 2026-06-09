-- S209: state_tax_forms catalog phase 7 — IN, MO, MD, WI, OR.
--
-- Top-5 by population from the unverified states pile. Brings catalog
-- past ~95% of US population by landlord-state coverage.
--
-- Pattern matches earlier phases:
--   - Stable form codes still in active agency use → paper_form
--   - Online-portal-only filings with retired/no paper code → online_portal
--   - Cadence-variable forms get NC-5 treatment (encode quarterly
--     variant + notes pointing to other-cadence options)
--
-- Special case — OR Form OQ: Oregon uses a single COMBINED quarterly
-- filing that covers W/H + UI + Workers' Benefit Fund + statewide
-- transit tax in one return. Encoded as 'unemployment' category since
-- UI is what most often drives this filing as a quarterly obligation;
-- notes spell out the combined nature so the landlord sees the full
-- scope.
--
-- Skipped this round (cadence-variable W/H deposit vouchers):
--   IN WH-1, MD MW506, WI WT-6 — same posture as OH IT-501 and CO
--   DR 1094. Annual W/H recon (WH-3, MW508, WT-7) covers the
--   landlord-visible deadline; vouchers don't add deadline visibility.

INSERT INTO state_tax_forms
  (state_code, form_code, form_name, agency, agency_url, category, frequency, due_dates, applies_to, statute, notes, effective_year, filing_method)
VALUES
  -- INDIANA
  ('IN', 'WH-3', 'Annual Withholding Reconciliation',
   'IN Department of Revenue',
   'https://www.in.gov/dor/business-tax/withholding-income-tax/',
   'reconciliation', 'annual',
   '[{"label":"Annual","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'IC 6-3-4-8',
   'Annual reconciliation of state income tax withheld; transmits W-2 totals to IN DOR.',
   2026, 'paper_form'),
  ('IN', 'IN UI Quarterly', 'Quarterly Wage and Tax Report',
   'IN Department of Workforce Development',
   'https://www.in.gov/dwd/employer-tax-account/',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'IC 22-4-10-1',
   'Filed online via Uplink Employer Self Service portal — paper form codes (UC-1 / UC-5A) retired. Combined UI contribution + per-employee wage detail.',
   2026, 'online_portal'),

  -- MISSOURI
  ('MO', 'MO-941', 'Employer''s Return of Income Taxes Withheld',
   'MO Department of Revenue',
   'https://dor.mo.gov/taxation/business/tax-types/withholding/',
   'withholding', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   '§ 143.221 RSMo',
   'For quarterly filers (under $500/qtr withholding). Higher-volume filers file MO-941 monthly. Annual W-2 transmittal is MO W-3.',
   2026, 'paper_form'),
  ('MO', 'MO UI Quarterly', 'Quarterly Wage and Contribution Report',
   'MO Department of Labor and Industrial Relations, Division of Employment Security',
   'https://labor.mo.gov/des/employers',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   '§ 288.090 RSMo',
   'Filed online via UInteract portal. Combined UI contribution + per-employee wage detail.',
   2026, 'online_portal'),

  -- MARYLAND
  ('MD', 'MW508', 'Annual Employer Withholding Reconciliation Return',
   'Comptroller of Maryland',
   'https://www.marylandtaxes.gov/business/income/withholding/',
   'reconciliation', 'annual',
   '[{"label":"Annual","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'Md. Code Ann. Tax-Gen. § 10-906',
   'Annual reconciliation of state + local income tax withheld; transmits W-2 totals.',
   2026, 'paper_form'),
  ('MD', 'MD UI Quarterly', 'Quarterly Contribution and Employment Report',
   'MD Department of Labor, Division of Unemployment Insurance',
   'https://labor.maryland.gov/employment/unemployment.shtml',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'Md. Code Ann. Lab. & Empl. § 8-625',
   'Filed online via BEACON portal — paper form code (DLLR/DUI 15/16) retired. Combined UI contribution + per-employee wage detail.',
   2026, 'online_portal'),

  -- WISCONSIN
  ('WI', 'WT-7', 'Annual Reconciliation of Wisconsin Income Tax Withheld',
   'WI Department of Revenue',
   'https://www.revenue.wi.gov/Pages/Businesses/Withholding-Tax.aspx',
   'reconciliation', 'annual',
   '[{"label":"Annual","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'Wis. Stat. § 71.65',
   'Annual reconciliation of state income tax withheld; transmits W-2 totals to WI DOR.',
   2026, 'paper_form'),
  ('WI', 'UCT-101', 'Quarterly Contribution Report (UI)',
   'WI Department of Workforce Development',
   'https://dwd.wisconsin.gov/ui/employers/',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'Wis. Stat. § 108.17',
   'UI contribution + per-employee wage detail. Filed via uctax.wisconsin.gov portal.',
   2026, 'paper_form'),

  -- OREGON (combined Form OQ — W/H + UI + WBF + transit tax in one quarterly filing)
  ('OR', 'Form OQ', 'Combined Quarterly Tax Report',
   'OR Department of Revenue + OR Employment Department (combined)',
   'https://www.oregon.gov/employ/businesses/tax/',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'ORS 316.197 (W/H), ORS 657 (UI)',
   'Single combined quarterly filing covering: state income tax withholding, UI contribution, Workers'' Benefit Fund assessment, and statewide transit tax. Filed via Frances Online portal.',
   2026, 'paper_form'),
  ('OR', 'OR-WR', 'Oregon Annual Withholding Tax Reconciliation Report',
   'OR Department of Revenue',
   'https://www.oregon.gov/dor/programs/businesses/Pages/withholding.aspx',
   'reconciliation', 'annual',
   '[{"label":"Annual","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'ORS 316.197',
   'Annual reconciliation of state income tax withheld; transmits W-2 totals.',
   2026, 'paper_form');
