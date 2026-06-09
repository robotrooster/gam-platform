-- S221: state_tax_forms catalog phase 9 — OK, IA, ID, NM, WV.
--
-- Resolves the form-code-uncertain pile flagged in S215 phase 8
-- carry-forward. Each state needed verification round; research
-- this round confirmed stable codes (or stable online-portal
-- labels where no paper code exists). Brings catalog past
-- previous coverage with 5 more states.
--
-- Two state-level oddities surfaced and encoded:
--
--   IA W/H — Iowa retired Form 44-007 VSP starting TY2022.
--     Annual reconciliation is now a W-2 electronic submission
--     to IDR with a due date of Feb 15 — neither Jan 31 nor
--     Feb 28. Encoded as 'IA W-2 Submission' / online_portal so
--     a landlord with property in Iowa doesn't think the only
--     Jan-Feb deadline is the federal Jan 31. Distinct from the
--     federal W-2/W-3 (filed with SSA, due Jan 31).
--
--   NM W/H — RPD-41072 due Feb 28 per N.M. Stat. Ann. § 7-3-7
--     ("on or before the last day of February of the year
--     following"). Mirrors AR AR3MAR / MI Form 5081 Feb 28
--     pattern.
--
-- Filing-method posture (continues from S207):
--   - paper_form when the state has a stable agency form code,
--     even when e-filing is mandatory (AR DWS-ARK-209B, KS
--     K-CNS 100, IA 65-5300, OK OES-3, ID Form 967, ID TAX-020,
--     NM RPD-41072, NM ES-903A, WV WV/IT-103, WV WVUC-A-154 fit
--     here). The form code is what a landlord searches for; the
--     filing channel is implementation detail.
--   - online_portal when no paper form exists and the filing
--     event needs a descriptive label (OK W-2 Reconciliation,
--     IA W-2 Submission fit here this round).
--
-- ID Form 967 is online-only via TAP starting TY2025 — encoded
-- as paper_form because the form code is stable (not retired
-- like AK TQ01 was). The note documents the TAP mandate.
--
-- WV UI is split across WVUC-A-154 (contribution) +
-- WVUC-A-154-A (per-employee wage detail). Encoded as one row
-- on the contribution form following the PA UC-2 pattern; wage
-- detail mentioned in notes.

INSERT INTO state_tax_forms
  (state_code, form_code, form_name, agency, agency_url, category, frequency, due_dates, applies_to, statute, notes, effective_year, filing_method)
VALUES
  -- OKLAHOMA
  ('OK', 'OK W-2 Reconciliation', 'Annual Withholding Reconciliation (W-2/W-3 Transmittal via OkTAP)',
   'OK Tax Commission',
   'https://oklahoma.gov/tax/businesses/withholding.html',
   'reconciliation', 'annual',
   '[{"label":"Annual","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'Okla. Stat. tit. 68 § 2385.3',
   'Oklahoma has no standalone state W-3 paper form. Annual reconciliation is the W-2/W-3 transmittal filed electronically through OkTAP — distinct from the federal W-2/W-3 to SSA. Up to $1,000 penalty if not filed within 30 days of the due date.',
   2026, 'online_portal'),
  ('OK', 'OES-3', 'Employer''s Quarterly Contribution Report (UI)',
   'OK Employment Security Commission',
   'https://oklahoma.gov/oesc/employers/tax/wage-reporting.html',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'Okla. Stat. tit. 40 § 3-102',
   'Combined UI tax + per-employee wage detail. Mandatory electronic filing via EZ Tax Express since Jan 2011, but OES-3 form code remains the official designation. Required even with zero wages in the quarter.',
   2026, 'paper_form'),

  -- IOWA
  ('IA', 'IA W-2 Submission', 'Annual W-2 Submission to Iowa Department of Revenue',
   'IA Department of Revenue',
   'https://revenue.iowa.gov/taxes/tax-guidance/withholding-tax/iowa-withholding-tax-information',
   'reconciliation', 'annual',
   '[{"label":"Annual","due":"Feb 15 (next year)"}]'::jsonb,
   'with_property_in_state',
   'Iowa Code § 422.16',
   'Iowa retired Form 44-007 VSP starting TY2022 — reconciliation is now satisfied solely by W-2 electronic submission to IDR. Due Feb 15 (NOT Jan 31 or Feb 28) — Iowa is the only state with this deadline. Distinct filing event from the federal W-2/W-3 to SSA.',
   2026, 'online_portal'),
  ('IA', '65-5300', 'Employer''s Contribution and Payroll Report (UI)',
   'IA Workforce Development',
   'https://workforce.iowa.gov/employers/unemployment-insurance/unemployment-insurance-employer-handbook',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'Iowa Code § 96.7',
   'Combined UI tax + per-employee wage detail. Mandatory electronic filing via myIowaUI since Sept 2013, but 65-5300 form code remains the official designation. Required even with zero wages in the quarter.',
   2026, 'paper_form'),

  -- IDAHO
  ('ID', 'Form 967', 'Idaho Annual Withholding Report',
   'ID State Tax Commission',
   'https://tax.idaho.gov/taxes/income-tax/withholding/withholding-filing/filing-form-967/',
   'reconciliation', 'annual',
   '[{"label":"Annual","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'Idaho Code § 63-3035',
   'Annual reconciliation of Idaho income tax withheld; reconciles Form 910 deposits with W-2/1099 totals. Online filing via TAP mandatory starting TY2025; form code remains official designation.',
   2026, 'paper_form'),
  ('ID', 'TAX-020', 'Employer Quarterly Unemployment Insurance Tax Report',
   'ID Department of Labor',
   'https://www2.labor.idaho.gov/UITaxReporting',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'Idaho Code § 72-1349',
   'Combined UI tax + wage report. Online filing via Idaho DOL Employer Portal mandatory; paper filing requires written exception request.',
   2026, 'paper_form'),

  -- NEW MEXICO
  ('NM', 'RPD-41072', 'Annual Summary of Withholding Tax',
   'NM Taxation and Revenue Department',
   'https://www.tax.newmexico.gov/businesses/withholding-tax-and-workers-compensation/',
   'reconciliation', 'annual',
   '[{"label":"Annual","due":"Feb 28 (next year)"}]'::jsonb,
   'with_property_in_state',
   'N.M. Stat. Ann. § 7-3-7',
   'Annual reconciliation of NM income tax withheld; transmits W-2 totals. Due Feb 28 per statute — NOT the typical Jan 31. File electronically via TAP or by mail.',
   2026, 'paper_form'),
  ('NM', 'ES-903A', 'Employer''s Quarterly Wage and Contribution Report (UI)',
   'NM Department of Workforce Solutions',
   'https://www.dws.state.nm.us/Unemployment',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'N.M. Stat. Ann. § 51-1-1',
   'Combined UI tax + per-employee wage detail. Filed via NM Workforce Connection portal; ES-903A form code remains official.',
   2026, 'paper_form'),

  -- WEST VIRGINIA
  ('WV', 'WV/IT-103', 'West Virginia Withholding Year End Reconciliation',
   'WV Tax Division',
   'https://tax.wv.gov/business/withholding/helpandgeneralinformation/Pages/WithholdingHelpAndGeneralInformation.aspx',
   'reconciliation', 'annual',
   '[{"label":"Annual","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'W. Va. Code § 11-21-74',
   'Annual reconciliation of WV income tax withheld; transmits W-2 totals. Electronic filing via MyTaxes mandatory for payroll-service users or 10+ employee filings starting TY2025.',
   2026, 'paper_form'),
  ('WV', 'WVUC-A-154', 'Employer''s Quarterly Contribution Report (UI)',
   'WorkForce West Virginia',
   'https://workforcewv.org/employers/unemployment-tax-services',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'W. Va. Code Chapter 21A',
   'WV splits UI filing across WVUC-A-154 (contribution totals) and WVUC-A-154-A (per-employee wage detail) — total wages on the wage report must balance with the contribution report. Encoded as one row on the contribution form following the PA UC-2 pattern.',
   2026, 'paper_form');
