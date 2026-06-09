-- S208: state_tax_forms catalog phase 6 — OH, PA, VA, MA, MI W/H.
--
-- Resolves the form-code-ambiguity pile flagged in S205 phase 3 carry-
-- forward. With S207's filing_method column, MA's online-only UI
-- filing collapses cleanly into online_portal; the rest are stable
-- paper-form codes that just needed verification.
--
-- Cadence-variable forms (M-941, MI 5080) get the NC-5 treatment:
-- encode the quarterly variant, notes point to other-cadence form
-- codes for higher/lower-volume filers. The form itself is identical
-- across cadences for these states; only the filing schedule varies.
--
-- Skipped this round:
--   OH IT-501 — cadence-variable W/H payment voucher; IT-941 annual
--     recon already captures the full-year picture for the catalog.
--   PA REV-1667 — annual W-2 transmittal; current form-code stability
--     uncertain. Defer.
--   PA UC-2A, VA FC-21 — wage-detail counterparts always filed
--     alongside UC-2 / FC-20. Merged into the parent rows via notes.
--   MI 5099 — amended quarterly return. Not a routine filing.

INSERT INTO state_tax_forms
  (state_code, form_code, form_name, agency, agency_url, category, frequency, due_dates, applies_to, statute, notes, effective_year, filing_method)
VALUES
  -- OHIO
  ('OH', 'IT-941', 'Annual Reconciliation of Income Tax Withheld',
   'OH Department of Taxation',
   'https://tax.ohio.gov/business/ohio-business-taxes/employer-withholding',
   'reconciliation', 'annual',
   '[{"label":"Annual","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'ORC § 5747.07',
   'Annual reconciliation of state income tax withheld; transmits W-2 totals.',
   2026, 'paper_form'),
  ('OH', 'JFS 20127', 'Quarterly Tax Return (UI)',
   'OH Department of Job and Family Services',
   'https://jfs.ohio.gov/ouio/employer-resources',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'ORC § 4141.20',
   'Combined UI tax + per-employee wage detail. Filed via The SOURCE employer portal.',
   2026, 'paper_form'),

  -- PENNSYLVANIA
  ('PA', 'PA W-3', 'Employer Quarterly Reconciliation Return of Income Tax Withheld',
   'PA Department of Revenue',
   'https://www.revenue.pa.gov/TaxTypes/EmployerWithholding/',
   'withholding', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   '72 P.S. § 7316',
   'PA W-3 is QUARTERLY despite the W-3 name (federal W-3 is annual). Annual W-2 transmittal handled separately via REV-1667.',
   2026, 'paper_form'),
  ('PA', 'UC-2', 'Employer''s Report for Unemployment Compensation',
   'PA Department of Labor and Industry, Office of Unemployment Compensation',
   'https://www.uc.pa.gov/employers-uc-services-uc-tax/',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   '43 P.S. § 781.1',
   'UI tax return. Filed alongside UC-2A wage detail (per-employee).',
   2026, 'paper_form'),

  -- VIRGINIA
  ('VA', 'VA-6', 'Employer''s Annual Summary of Virginia Income Tax Withheld',
   'VA Department of Taxation',
   'https://www.tax.virginia.gov/withholding-tax',
   'reconciliation', 'annual',
   '[{"label":"Annual","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'Va. Code § 58.1-471',
   'Annual reconciliation of state income tax withheld; transmits W-2 totals.',
   2026, 'paper_form'),
  ('VA', 'FC-20', 'Employer''s Quarterly Tax Report (UI)',
   'VA Employment Commission',
   'https://www.vec.virginia.gov/employers',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'Va. Code § 60.2-512',
   'UI tax return. Filed alongside FC-21 payroll report (per-employee wage detail).',
   2026, 'paper_form'),

  -- MASSACHUSETTS
  ('MA', 'M-941', 'Employer''s Return of Income Taxes Withheld',
   'MA Department of Revenue',
   'https://www.mass.gov/info-details/withholding-tax',
   'withholding', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'M.G.L. c. 62B § 5',
   'For quarterly filers (under $1,200/yr withholding). Higher-volume filers use M-941M (monthly) or M-941W (weekly). Annual reconciliation is M-3.',
   2026, 'paper_form'),
  ('MA', 'MA UI Quarterly', 'Quarterly Employment and Wage Detail Report',
   'MA Department of Unemployment Assistance',
   'https://www.mass.gov/orgs/department-of-unemployment-assistance',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'M.G.L. c. 151A § 14',
   'Filed online via UI Online portal — no paper form. Combined UI contribution + per-employee wage detail.',
   2026, 'online_portal'),

  -- MICHIGAN (W/H additions; UIA 1028 already in catalog from S205)
  ('MI', 'Form 5081', 'Sales, Use and Withholding Taxes Annual Return',
   'MI Department of Treasury',
   'https://www.michigan.gov/taxes/business-taxes/withholding',
   'reconciliation', 'annual',
   '[{"label":"Annual","due":"Feb 28 (next year)"}]'::jsonb,
   'with_property_in_state',
   'MCL 206.703',
   'Annual reconciliation covering both withholding and sales/use tax in one return. W-2 transmittal also tied to this filing.',
   2026, 'paper_form'),
  ('MI', 'Form 5080', 'Sales, Use and Withholding Taxes Monthly/Quarterly Return',
   'MI Department of Treasury',
   'https://www.michigan.gov/taxes/business-taxes/withholding',
   'withholding', 'quarterly',
   '[{"label":"Q1","due":"Apr 20"},{"label":"Q2","due":"Jul 20"},{"label":"Q3","due":"Oct 20"},{"label":"Q4","due":"Jan 20 (next year)"}]'::jsonb,
   'with_property_in_state',
   'MCL 206.703',
   'For quarterly filers. Same form is used by monthly filers on monthly cadence (20th of following month). Combines withholding + sales/use tax. Note: MI uses 20th-of-month deadlines, not the 30/31st most other states use.',
   2026, 'paper_form');
