-- S207: state_tax_forms.filing_method column + online-portal seed (MN, SD, WY, AK).
--
-- Phase 4 (S206) hit a wall: MN, SD, WY, AK all have quarterly UI
-- filings that are online-portal-only with no stable paper form code.
-- The conservative posture says don't fabricate a code (a landlord
-- googling "MN Form 9" finds nothing, looks negligent), but the
-- catalog needs them — combined population is non-trivial and a
-- landlord with property in any of those four states still owes
-- quarterly UI.
--
-- This migration adds a `filing_method` enum-like column:
--   'paper_form'   — form_code is an official agency code (existing rows)
--   'online_portal'— form_code is a descriptive label; landlord files
--                    online via agency_url; no paper form to look up
--
-- Backfill: not needed. Default 'paper_form' covers all 26 existing rows
-- (US, AZ, CA, CO, FL, GA, IL, MI, NC, NJ, NV, NY, TN, TX, WA — all
-- catalog forms ARE paper-form-with-optional-e-file, not portal-only).
--
-- Then: insert the 4 deferred online-portal UI rows. form_code is a
-- stable per-state label. notes spell out the portal posture so a
-- landlord doesn't go searching for a paper form.

ALTER TABLE state_tax_forms
  ADD COLUMN filing_method text NOT NULL DEFAULT 'paper_form';

ALTER TABLE state_tax_forms
  ADD CONSTRAINT state_tax_forms_filing_method_check
    CHECK (filing_method = ANY (ARRAY['paper_form'::text, 'online_portal'::text]));

COMMENT ON COLUMN state_tax_forms.filing_method IS
  'S207: paper_form (form_code is official agency code) vs online_portal (form_code is descriptive label, file via agency_url). Source of truth for values: packages/shared/src/index.ts FILING_METHOD_VALUES.';

-- ── Seed: online-portal UI quarterly rows for MN, SD, WY, AK ────────

INSERT INTO state_tax_forms
  (state_code, form_code, form_name, agency, agency_url, category, frequency, due_dates, applies_to, statute, notes, effective_year, filing_method)
VALUES
  -- MINNESOTA — UI Wage Detail Report (quarterly, online-only via UIMN)
  ('MN', 'MN UI Wage Detail', 'Quarterly UI Wage Detail Report',
   'MN Department of Employment and Economic Development',
   'https://www.uimn.org/employers/',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'Minn. Stat. § 268.044',
   'Filed online via UIMN.org employer portal — no paper form. Per-employee wage detail + UI tax in one submission.',
   2026, 'online_portal'),

  -- SOUTH DAKOTA — Quarterly Contribution and Wage Report (online via SUITS)
  ('SD', 'SD UI Quarterly', 'Quarterly Contribution and Wage Report',
   'SD Department of Labor and Regulation, Reemployment Assistance',
   'https://dlr.sd.gov/ra/employers/',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'SDCL § 61-5-24',
   'Filed online via SUITS portal (suits.sd.gov) — no paper form. South Dakota has no state income tax.',
   2026, 'online_portal'),

  -- WYOMING — Quarterly UI Wage and Tax Report (online via WYUI)
  ('WY', 'WY UI Quarterly', 'Quarterly UI Wage and Tax Report',
   'WY Department of Workforce Services, Unemployment Tax Division',
   'https://dws.wyo.gov/dws-division/unemployment-tax/',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'Wyo. Stat. § 27-3-504',
   'Filed online via WYUI / WYservices portal — no paper form. Wyoming has no state income tax.',
   2026, 'online_portal'),

  -- ALASKA — Quarterly Contribution Report (online via myAlaska)
  ('AK', 'AK Quarterly Contribution', 'Quarterly Contribution Report (UI)',
   'AK Department of Labor and Workforce Development, Employment Security',
   'https://labor.alaska.gov/estax/',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'AS § 23.20.165',
   'Filed online via Employer Self-Service portal — historical paper code TQ01 retired. Alaska has no state income tax. Note: AK is unique in that employees also pay UI tax (employee contribution withheld from wages).',
   2026, 'online_portal');
