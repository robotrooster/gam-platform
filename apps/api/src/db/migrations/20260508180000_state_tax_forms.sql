-- S203: 50-state property tax form catalog phase 1.
--
-- Per CLAUDE.md S177 carve-out: "State tax form catalog — each state
-- has its own quarterly/annual withholding + unemployment forms with
-- state-specific due dates. Per-property (LLCs file by state). GAM
-- surfaces the deadlines; we do NOT file forms on anyone's behalf."
--
-- Annual-refresh migration cadence — to extend, write a new migration
-- adding rows for the next effective_year. Don't UPDATE existing rows
-- in place.
--
-- Phase 1 scope:
--   - Schema only + initial seed: federal (hardcoded in books.ts before
--     S203) + AZ + CA + TX. New York + Illinois + Florida + others to
--     follow in phase 2 once the surface is verified end-to-end.
--   - Books portal annual summary picks up the catalog instead of the
--     hardcoded federal-only list.
--
-- `applies_to`:
--   'all_landlords'              — every landlord (federal forms here)
--   'with_employees_in_state'    — landlord has an employee tagged to
--                                   this state via books_employees
--   'with_property_in_state'     — landlord owns a property in this
--                                   state (most state-tax forms map
--                                   here — the entity files where the
--                                   property + LLC operate)
--   'with_contractors_paid_600'  — paid any 1099-NEC contractor $600+
--                                   in the calendar year (federal
--                                   1099-NEC trigger)

CREATE TABLE state_tax_forms (
  id              uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  state_code      text NOT NULL,             -- 'US' for federal, 2-letter for state
  form_code       text NOT NULL,             -- 'A1-QRT', 'DE-9', '941'
  form_name       text NOT NULL,             -- human-readable
  agency          text NOT NULL,             -- 'IRS', 'AZ Dept of Revenue', 'CA EDD', etc.
  agency_url      text,                      -- file-online URL
  category        text NOT NULL,             -- 'withholding' | 'unemployment' | 'reconciliation' | 'income' | 'sales_tax' | 'other'
  frequency       text NOT NULL,             -- 'quarterly' | 'annual' | 'monthly' | 'biennial'
  due_dates       jsonb NOT NULL,            -- e.g. [{ label: 'Q1', due: 'Apr 30' }, ...]
  applies_to      text NOT NULL,
  statute         text,
  notes           text,
  effective_year  integer NOT NULL,
  created_at      timestamp with time zone NOT NULL DEFAULT NOW(),
  CONSTRAINT state_tax_forms_state_check
    CHECK (state_code = upper(state_code) AND length(state_code) = 2),
  CONSTRAINT state_tax_forms_year_check
    CHECK (effective_year BETWEEN 2020 AND 2100),
  CONSTRAINT state_tax_forms_category_check
    CHECK (category = ANY (ARRAY['withholding'::text, 'unemployment'::text, 'reconciliation'::text, 'income'::text, 'sales_tax'::text, 'other'::text])),
  CONSTRAINT state_tax_forms_frequency_check
    CHECK (frequency = ANY (ARRAY['quarterly'::text, 'annual'::text, 'monthly'::text, 'biennial'::text])),
  CONSTRAINT state_tax_forms_applies_check
    CHECK (applies_to = ANY (ARRAY['all_landlords'::text, 'with_employees_in_state'::text, 'with_property_in_state'::text, 'with_contractors_paid_600'::text])),
  CONSTRAINT state_tax_forms_unique
    UNIQUE (state_code, form_code, effective_year)
);

CREATE INDEX idx_state_tax_forms_state_year ON state_tax_forms(state_code, effective_year);

COMMENT ON TABLE state_tax_forms IS
  'S203 / S177 carve-out: hardcoded per-state tax form catalog with annual-refresh migration cadence. GAM surfaces deadlines; never files forms.';

-- ── Seed: federal forms (moved from books.ts hardcoded list) ─────────────

INSERT INTO state_tax_forms
  (state_code, form_code, form_name, agency, agency_url, category, frequency, due_dates, applies_to, statute, notes, effective_year)
VALUES
  ('US', '941', 'Employer''s Quarterly Federal Tax Return',
   'IRS', 'https://www.irs.gov/forms-pubs/about-form-941', 'withholding', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_employees_in_state', '26 U.S.C. § 6011', 'Reports federal income tax withheld + employer/employee SS + Medicare. Required if you have any employees.', 2026),
  ('US', '940', 'Annual Federal Unemployment (FUTA) Tax Return',
   'IRS', 'https://www.irs.gov/forms-pubs/about-form-940', 'unemployment', 'annual',
   '[{"label":"Annual","due":"Jan 31 (next year)"}]'::jsonb,
   'with_employees_in_state', '26 U.S.C. § 3301', 'Federal unemployment tax. Required if you paid wages of $1,500+ in any quarter or had an employee for any 20 weeks of the year.', 2026),
  ('US', 'W-2/W-3', 'Wage and Tax Statements (employees + SSA)',
   'SSA', 'https://www.ssa.gov/employer/', 'reconciliation', 'annual',
   '[{"label":"Annual","due":"Jan 31 (next year)"}]'::jsonb,
   'with_employees_in_state', '26 U.S.C. § 6051', 'W-2 to each employee, W-3 transmittal to SSA. Same Jan 31 deadline.', 2026),
  ('US', '1099-NEC', 'Nonemployee Compensation (contractors paid $600+)',
   'IRS', 'https://www.irs.gov/forms-pubs/about-form-1099-nec', 'reconciliation', 'annual',
   '[{"label":"Annual","due":"Jan 31 (next year)"}]'::jsonb,
   'with_contractors_paid_600', '26 U.S.C. § 6041A', 'Per contractor paid $600+ in the calendar year.', 2026);

-- ── Seed: AZ, CA, TX (starter set; expand in phase 2) ────────────────────

INSERT INTO state_tax_forms
  (state_code, form_code, form_name, agency, agency_url, category, frequency, due_dates, applies_to, statute, notes, effective_year)
VALUES
  -- ARIZONA
  ('AZ', 'A1-QRT', 'Quarterly Withholding Tax Return',
   'AZ Department of Revenue', 'https://azdor.gov/business/withholding-tax', 'withholding', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state', 'A.R.S. § 43-401', 'Reports state income tax withheld from employee wages.', 2026),
  ('AZ', 'A1-R', 'Annual Withholding Reconciliation',
   'AZ Department of Revenue', 'https://azdor.gov/business/withholding-tax', 'reconciliation', 'annual',
   '[{"label":"Annual","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state', 'A.R.S. § 43-401', 'Annual reconciliation of A1-QRT filings + W-2 totals.', 2026),
  ('AZ', 'UC-018', 'Quarterly Unemployment Tax and Wage Report',
   'AZ DES', 'https://des.az.gov/services/employment/unemployment-employer', 'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state', 'A.R.S. § 23-722', 'Combined unemployment tax + wage reporting.', 2026),

  -- CALIFORNIA
  ('CA', 'DE-9', 'Quarterly Contribution Return and Report of Wages',
   'CA EDD', 'https://edd.ca.gov/en/payroll_taxes/Required_Filings_and_Due_Dates/', 'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state', 'CA UI Code § 1088', 'Combined CA UI + ETT + SDI + PIT contributions.', 2026),
  ('CA', 'DE-9C', 'Quarterly Contribution and Wage Adjustment Form',
   'CA EDD', 'https://edd.ca.gov/en/payroll_taxes/Required_Filings_and_Due_Dates/', 'reconciliation', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state', 'CA UI Code § 1088', 'Per-employee wage detail filed with DE-9.', 2026),

  -- TEXAS (no state income tax; only unemployment)
  ('TX', 'C-3/C-4', 'Employer''s Quarterly Report (UI)',
   'TX Workforce Commission', 'https://www.twc.texas.gov/businesses/quarterly-reports', 'unemployment', 'quarterly',
   '[{"label":"Q1","due":"Apr 30"},{"label":"Q2","due":"Jul 31"},{"label":"Q3","due":"Oct 31"},{"label":"Q4","due":"Jan 31 (next year)"}]'::jsonb,
   'with_property_in_state', 'TX Labor Code § 204.002', 'Combined unemployment tax + wage reporting. Texas has no state income tax.', 2026);
