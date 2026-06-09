-- S204: state_tax_forms catalog phase 2 — expand to NY, IL, FL, WA.
--
-- Conservative expansion: only forms with clear statutory basis,
-- well-known form codes, and quarterly-or-simpler cadence that fits
-- the catalog's due_dates jsonb shape. Variable-cadence forms (e.g.
-- NY NYS-1 deposit returns whose frequency depends on prior-year
-- withholding) and category-questionable forms (e.g. WA B&O tax for
-- residential rentals — typically exempt) are deferred until phase
-- 3 once the surface is more battle-tested.
--
-- Annual-refresh cadence: this migration is for effective_year=2026.
-- 2027 extension is a future migration.

INSERT INTO state_tax_forms
  (state_code, form_code, form_name, agency, agency_url, category, frequency, due_dates, applies_to, statute, notes, effective_year)
VALUES
  -- NEW YORK
  ('NY', 'NYS-45', 'Quarterly Combined Withholding, Wage Reporting, and Unemployment Insurance Return',
   'NY Department of Taxation and Finance',
   'https://www.tax.ny.gov/bus/wt/nys45.htm',
   'withholding', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'N.Y. Tax Law § 671 / N.Y. Lab. Law § 575',
   'Combined return — covers state withholding, wage reporting, and UI in one filing.',
   2026),

  -- ILLINOIS
  ('IL', 'IL-941', 'Quarterly Illinois Withholding Income Tax Return',
   'IL Department of Revenue',
   'https://tax.illinois.gov/forms/withholding.html',
   'withholding', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   '35 ILCS 5/704A',
   'Required even if zero withholding for the quarter, once you''re registered as an IL employer.',
   2026),
  ('IL', 'UI-3/40', 'Employer''s Contribution and Wage Report',
   'IL Department of Employment Security',
   'https://ides.illinois.gov/employer-resources/taxes-reporting.html',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   '820 ILCS 405/1402',
   'IL UI tax + per-employee wage detail.',
   2026),

  -- FLORIDA (no state income tax; only reemployment tax)
  ('FL', 'RT-6', 'Employer''s Quarterly Report (Reemployment Tax)',
   'FL Department of Revenue',
   'https://floridarevenue.com/taxes/taxesfees/Pages/reemployment.aspx',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'Fla. Stat. § 443.131',
   'FL''s "reemployment tax" is the state UI equivalent. No state income tax means no withholding form.',
   2026),

  -- WASHINGTON (no state income tax)
  ('WA', '5208', 'Quarterly Tax and Wage Report',
   'WA Employment Security Department',
   'https://esd.wa.gov/employer-taxes',
   'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state',
   'RCW 50.12.070',
   'WA UI quarterly. No state income tax. B&O tax (Combined Excise Tax Return) usually exempt for residential rentals — see WAC 458-20-118.',
   2026);
