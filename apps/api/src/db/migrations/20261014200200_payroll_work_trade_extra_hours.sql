-- 10/12 (Nic) — GAM BOOKS, PHASE P7: WORK-TRADE EXTRA HOURS SENT TO BOOKS BECOME A PAYCHECK
--
-- Nic, 10/12: paid extra work-trade hours are wages the landlord pays a person,
-- "Both" ways — by hand (Mark paid on the Work Trade page) or by pressing Send
-- to GAM Books, where they become payroll (W-2) or a contractor payment
-- (1099). work_trade_extra_hours (migration 20261012180200) left
-- books_reference_id NULL "until GAM Books picks it up". This is the payroll
-- half of the pickup (design I6):
--
--   payroll_run_lines.work_trade_extra_hours_id
--       the sent record a paycheck pays. The person running payroll confirms
--       which employee the work trader is and puts the hours on a run; the
--       line is its own paycheck line (hours, the agreement's rate, gross =
--       the record's amount) with its own withholding. Approving the run marks
--       the record paid with books_reference_id = the run; voiding the run
--       puts it back to "Sent to GAM Books" (routes/books.ts). RESTRICT: the
--       record is never removed (keep-everything).
--   books_employees.tenant_id
--       the tenant an employee record is (a work trader on payroll), filled
--       the first time their extra hours go on a run, so the next time the
--       right employee is already picked. One tenant per employee record of a
--       company. SET NULL is never needed: tenants are never removed.
--
-- Expand-only; safe before the code ships. No backfill needed: nothing has
-- been picked up yet (production had 0 work_trade_extra_hours rows on 10/12 —
-- the table itself had not shipped).
-- Safe drop: the two columns and their indexes.

SET LOCAL lock_timeout = '10s';

ALTER TABLE payroll_run_lines
  ADD COLUMN IF NOT EXISTS work_trade_extra_hours_id uuid REFERENCES work_trade_extra_hours(id);
CREATE INDEX IF NOT EXISTS payroll_run_lines_work_trade_extra_hours
  ON payroll_run_lines (work_trade_extra_hours_id) WHERE work_trade_extra_hours_id IS NOT NULL;

ALTER TABLE books_employees
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);
CREATE UNIQUE INDEX IF NOT EXISTS books_employees_landlord_tenant
  ON books_employees (landlord_id, tenant_id) WHERE tenant_id IS NOT NULL AND landlord_id IS NOT NULL;

COMMENT ON COLUMN payroll_run_lines.work_trade_extra_hours_id IS
  '10/12 (Nic, ledger P7): the work-trade extra hours (sent to GAM Books as W-2 pay) this paycheck line pays.';
COMMENT ON COLUMN books_employees.tenant_id IS
  '10/12 (Nic, ledger P7): the tenant this employee record is — a work trader paid for extra hours through payroll.';
