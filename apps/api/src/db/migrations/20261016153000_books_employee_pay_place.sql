-- 10/14 (Nic) — PAYROLL IS PLACED PER EMPLOYEE, SET ONCE.
--
-- Nic, 10/14: "an employee at one property goes to that property ... once you
-- set it it shouldnt change. if they work at multiple properties it would be
-- at the company level". Each paycheck follows its employee's place; the
-- per-run pick (payroll_runs.cost_place, 20261015230000) is no longer asked.
--
-- 1. books_employees.pay_place / pay_property_id — where this employee's pay
--    (gross wages and the employer's taxes on them) goes: 'property' (that
--    property) or 'company' (company level: someone who works at several
--    properties; the Company column, property NULL). Asked on the employee
--    form; once set it does not change (routes/books.ts refuses a change).
--    NULL: not set yet — the employee gets one before their next paycheck.
--    pay_place_set_at / pay_place_set_by say when and by whom.
--
-- 2. payroll_run_lines.pay_place / pay_property_id — the place each paycheck
--    was booked with, copied from its employee when the run is calculated (or,
--    for a draft calculated before this, when it is approved), so a run never
--    moves after it posts. NULL on every paycheck of a run approved before
--    10/14: that run posts as it did, by its own payroll_runs.cost_place.
--
-- The capture: pay_place and pay_property_id are appended to payroll_run_lines'
-- capture list (LEDGER_CAPTURE_COLUMNS in packages/shared, same order), so a
-- paycheck's place changing re-posts its run.
--
-- No money column. Expand-only; no backfill (employees get their place on the
-- form). Safe to drop with the code that reads it (re-install the capture
-- without the two columns first). Idempotent.

ALTER TABLE books_employees ADD COLUMN IF NOT EXISTS pay_place text;
ALTER TABLE books_employees ADD COLUMN IF NOT EXISTS pay_property_id uuid REFERENCES properties(id);
ALTER TABLE books_employees ADD COLUMN IF NOT EXISTS pay_place_set_at timestamptz;
ALTER TABLE books_employees ADD COLUMN IF NOT EXISTS pay_place_set_by uuid REFERENCES users(id);

ALTER TABLE books_employees DROP CONSTRAINT IF EXISTS books_employees_pay_place_check;
ALTER TABLE books_employees ADD CONSTRAINT books_employees_pay_place_check
  CHECK ((pay_place IS NULL AND pay_property_id IS NULL)
         OR (landlord_id IS NOT NULL
             AND ((pay_place = 'property' AND pay_property_id IS NOT NULL)
                  OR (pay_place = 'company' AND pay_property_id IS NULL))));

ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS pay_place text;
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS pay_property_id uuid REFERENCES properties(id);

ALTER TABLE payroll_run_lines DROP CONSTRAINT IF EXISTS payroll_run_lines_pay_place_check;
ALTER TABLE payroll_run_lines ADD CONSTRAINT payroll_run_lines_pay_place_check
  CHECK ((pay_place IS NULL AND pay_property_id IS NULL)
         OR (pay_place = 'property' AND pay_property_id IS NOT NULL)
         OR (pay_place = 'company' AND pay_property_id IS NULL));

COMMENT ON COLUMN books_employees.pay_place IS
  '10/14 (Nic): where this employee''s pay goes — property (pay_property_id) or company (company level, someone at several properties). Set once on the employee form; never changed. NULL: not set yet (asked before their next paycheck). BOOKS_EMPLOYEE_PAY_PLACES.';
COMMENT ON COLUMN books_employees.pay_property_id IS
  '10/14 (Nic): the property this employee''s pay goes to (pay_place property).';
COMMENT ON COLUMN books_employees.pay_place_set_at IS
  '10/14 (Nic): when the employee''s pay place was set.';
COMMENT ON COLUMN books_employees.pay_place_set_by IS
  '10/14 (Nic): who set the employee''s pay place.';
COMMENT ON COLUMN payroll_run_lines.pay_place IS
  '10/14 (Nic): the place this paycheck was booked with, copied from its employee (property or company). NULL: a paycheck on a run approved before 10/14 — the run''s own cost_place places it.';
COMMENT ON COLUMN payroll_run_lines.pay_property_id IS
  '10/14 (Nic): the property this paycheck was booked to (pay_place property).';

-- ── The ledger capture (LEDGER_CAPTURE_COLUMNS in packages/shared) ──────────
-- As 20261014200100 installed it, plus the paycheck's place.
SELECT ledger_install_capture('payroll_run_lines',
  ARRAY['run_id', 'employee_id', 'gross_pay', 'federal_tax', 'state_tax', 'ss_tax', 'medicare_tax',
        'other_deductions', 'net_pay',
        'employer_ss_tax', 'employer_medicare_tax', 'futa_tax', 'suta_tax',
        'pay_place', 'pay_property_id'],
  $k$SELECT 'payroll_run'::text, r.run_id::text, (SELECT COALESCE(pr.landlord_id, pr.business_id) FROM payroll_runs pr WHERE pr.id = r.run_id)$k$);

SELECT ledger_check_capture();
