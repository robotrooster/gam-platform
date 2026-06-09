-- S206: state_tax_forms catalog phase 4 — CO, TN, NV.
--
-- Conservative expansion. Tax-form data carries real consequence
-- (landlord misses a filing because we labeled it wrong → penalty);
-- only adding forms where the form code, agency, and cadence are
-- well-documented enough that I'd stake "do not get this wrong"
-- on it.
--
-- Skipped this round, deferred to phase 5+:
--   MN, SD, WY, AK — UI quarterly filings are online-portal-only
--     without a stable paper form code. Encoding a fabricated code
--     would mislead landlords. Need to surface "online via <portal>"
--     as a first-class state in the catalog data model first.
--   NV MBT (TXR-020.05) — most GAM landlords sit below the $50k/
--     quarter taxable wage threshold; would create false-positive
--     deadlines. Add when product surfaces threshold gating.
--   OH (IT-941 + JFS 20127), PA (UC-2 + W-3 cadence), VA (FC-20 /
--     FC-21 / VA-6), MA (M-941 + 0500), MI withholding (5080/5081/
--     5099 chain) — form-code or cadence ambiguity flagged in S205.

INSERT INTO state_tax_forms
  (state_code, form_code, form_name, agency, agency_url, category, frequency, due_dates, applies_to, statute, notes, effective_year)
VALUES
  -- COLORADO
  ('CO', 'DR 1093', 'Annual Transmittal of State W-2s (Withholding Reconciliation)',
   'CO Department of Revenue',
   'https://tax.colorado.gov/withholding-tax',
   'reconciliation', 'annual',
   '[{"label":"Annual","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'C.R.S. § 39-22-604',
   'Annual reconciliation of state income tax withheld; transmits W-2 totals to CO DOR.',
   2026),
  ('CO', 'UITR-1', 'Unemployment Insurance Tax Report',
   'CO Department of Labor and Employment',
   'https://cdle.colorado.gov/employers',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'C.R.S. § 8-76-102',
   'Quarterly UI tax + wage detail. Filed via MyUI Employer portal.',
   2026),

  -- TENNESSEE (no state income tax; UI only)
  ('TN', 'LB-0456', 'Premium and Wage Report',
   'TN Department of Labor and Workforce Development',
   'https://www.tn.gov/workforce/employers/tax-information.html',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'T.C.A. § 50-7-403',
   'Combined UI premium + per-employee wage detail. Tennessee has no state income tax.',
   2026),

  -- NEVADA (no state income tax; UI only — MBT deferred for threshold gating)
  ('NV', 'NUCS-4072', 'Employer''s Quarterly Contribution and Wage Report',
   'NV Department of Employment, Training and Rehabilitation (DETR)',
   'https://detr.nv.gov/Page/Employers',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'NRS 612.535',
   'Combined UI contribution + per-employee wage detail. Nevada has no state income tax. Higher-payroll employers may also owe Modified Business Tax (TXR-020.05) above $50k/quarter wages — not encoded here.',
   2026);
