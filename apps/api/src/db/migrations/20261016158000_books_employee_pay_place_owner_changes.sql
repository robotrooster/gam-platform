-- 10/14 afternoon (Nic): "Payroll place: the owner can change it; only future
-- paychecks follow." 20261016153000 described books_employees.pay_place as
-- set once and never changed; the owner may now change it (a mistake, or the
-- person moved). Anyone who keeps the books sets it the first time; only the
-- owner changes it (routes/books.ts PATCH /employees/:id,
-- services/booksEmployeePayPlace). The employee's paychecks on payroll runs
-- still in draft move with the change; every approved run keeps the place its
-- paychecks were booked with (payroll_run_lines.pay_place).
--
-- Column comments only: no column, constraint or data changes. Expand-only and
-- idempotent (COMMENT ON replaces). Nothing to drop.

COMMENT ON COLUMN books_employees.pay_place IS
  '10/14 (Nic): where this employee''s pay goes — property (pay_property_id) or company (company level, someone at several properties). Asked on the employee form. 10/14 afternoon (Nic): only the owner changes it once set; only future paychecks follow (draft runs move with it, approved runs stay as posted). NULL: not set yet (asked before their next paycheck). BOOKS_EMPLOYEE_PAY_PLACES.';
COMMENT ON COLUMN books_employees.pay_place_set_at IS
  '10/14 (Nic): when the employee''s pay place was set, or last changed by the owner.';
COMMENT ON COLUMN books_employees.pay_place_set_by IS
  '10/14 (Nic): who set the employee''s pay place, or last changed it (the owner).';
COMMENT ON COLUMN payroll_run_lines.pay_place IS
  '10/14 (Nic): the place this paycheck was booked with, copied from its employee (property or company). A draft run''s paychecks follow the owner''s change of the employee''s place; once the run is approved it never moves. NULL: a paycheck on a run approved before 10/14 — the run''s own cost_place places it.';
