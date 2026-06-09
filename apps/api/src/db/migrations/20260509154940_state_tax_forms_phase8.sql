-- S215: state_tax_forms catalog phase 8 — AR, KS, MS, NH, MT.
--
-- Mid-population states from the unverified pile. Brings catalog
-- past ~98% US population coverage. Conservative posture from
-- earlier phases continues — only encoding forms with stable codes
-- + clear statutory basis.
--
-- NH: state has no broad income tax (interest/dividends only,
-- being phased out), so no W/H quarterly form needed. UI is filed
-- online via NHES WebTax with no current paper code; encoded as
-- online_portal following the MN/SD/WY/AK/MA pattern.
--
-- Skipped this round (cadence-variable W/H deposits — pattern
-- continues from earlier phases):
--   AR AR-941 (cadence-variable; AR3MAR annual recon covers it)
--   KS KW-5 (cadence-variable; KW-3 annual recon covers it)
--   MS 89-105 (cadence-variable; 89-140 annual recon covers it)
--   MT MW-1 (cadence-variable; MW-3 annual recon covers it)
-- Also skipped: OK + IA + ID + NM + WV + others — uncertain on
-- current form-code stability, defer to a phase 9 verification
-- round.

INSERT INTO state_tax_forms
  (state_code, form_code, form_name, agency, agency_url, category, frequency, due_dates, applies_to, statute, notes, effective_year, filing_method)
VALUES
  -- ARKANSAS
  ('AR', 'AR3MAR', 'Annual Reconciliation of Income Tax Withheld',
   'AR Department of Finance and Administration',
   'https://www.dfa.arkansas.gov/income-tax/withholding-tax/',
   'reconciliation', 'annual',
   '[{"label":"Annual","due":"Feb 28 (next year)"}]'::jsonb,
   'with_property_in_state',
   'A.C.A. § 26-51-907',
   'Annual W-2 transmittal + reconciliation of state income tax withheld.',
   2026, 'paper_form'),
  ('AR', 'DWS-ARK-209B', 'Quarterly Contribution and Wage Report (UI)',
   'AR Department of Workforce Services',
   'https://www.dws.arkansas.gov/employers/',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'A.C.A. § 11-10-715',
   'Combined UI contribution + per-employee wage detail.',
   2026, 'paper_form'),

  -- KANSAS
  ('KS', 'KW-3', 'Annual Withholding Tax Return',
   'KS Department of Revenue',
   'https://www.ksrevenue.gov/bustaxtypeswh.html',
   'reconciliation', 'annual',
   '[{"label":"Annual","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'K.S.A. 79-3296',
   'Annual reconciliation + W-2 transmittal. Replaces the W-2 paper transmittal for KS withholding.',
   2026, 'paper_form'),
  ('KS', 'K-CNS 100', 'Quarterly Wage Report and Unemployment Tax Return',
   'KS Department of Labor',
   'https://www.dol.ks.gov/employers',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'K.S.A. 44-714',
   'Combined UI tax + per-employee wage detail.',
   2026, 'paper_form'),

  -- MISSISSIPPI
  ('MS', '89-140', 'Annual Information Return / W-2 Transmittal (Withholding Reconciliation)',
   'MS Department of Revenue',
   'https://www.dor.ms.gov/business/withholding-tax',
   'reconciliation', 'annual',
   '[{"label":"Annual","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'Miss. Code Ann. § 27-7-301',
   'Annual reconciliation of state income tax withheld; transmits W-2 totals.',
   2026, 'paper_form'),
  ('MS', 'UI-2/UI-3', 'Quarterly Wage Report + Tax Return (UI)',
   'MS Department of Employment Security',
   'https://mdes.ms.gov/employers/',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'Miss. Code Ann. § 71-5-355',
   'Paired filing — UI-2 wage report + UI-3 tax return. Filed together.',
   2026, 'paper_form'),

  -- NEW HAMPSHIRE (no broad state income tax; UI only, online portal)
  ('NH', 'NH UI Quarterly', 'Quarterly Tax and Wage Report (UI)',
   'NH Department of Employment Security',
   'https://www.nhes.nh.gov/employer/',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'RSA 282-A:14',
   'Filed online via NHES WebTax portal — no paper form code. New Hampshire has no broad state income tax (interest/dividends only, being phased out).',
   2026, 'online_portal'),

  -- MONTANA
  ('MT', 'MW-3', 'Annual Wage and Tax Statement Reconciliation',
   'MT Department of Revenue',
   'https://mtrevenue.gov/taxes/wage-withholding/',
   'reconciliation', 'annual',
   '[{"label":"Annual","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'Mont. Code Ann. § 15-30-2502',
   'Annual reconciliation of state income tax withheld; transmits W-2 totals.',
   2026, 'paper_form'),
  ('MT', 'UI-5', 'Employer''s Quarterly Unemployment Insurance Tax Report',
   'MT Department of Labor and Industry, UI Division',
   'https://uid.dli.mt.gov/employers',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'Mont. Code Ann. § 39-51-1109',
   'Combined UI tax + per-employee wage detail.',
   2026, 'paper_form');
