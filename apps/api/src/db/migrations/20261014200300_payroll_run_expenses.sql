-- 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P7: WHAT A PAYROLL RUN LEAVES OWED IS MONEY OUT ON ONE RECORD
--
-- Nic, 10/12 (L5): money out is ONE record — every dollar out is an expense
-- on the Expenses record, a bill is an unpaid expense, and a bank line pays
-- (matches) one. Design J3: an approved payroll run "also creates unpaid
-- payroll_net and tax_payment expenses that bank lines match":
--   payroll_net   one per paycheck — the take-home pay, paid by the check or
--                 direct deposit the bank line shows
--   tax_payment   one per payroll liability the run left owed — federal
--                 income tax withheld, Social Security and Medicare (both
--                 halves), federal unemployment, state income tax withheld,
--                 state unemployment, other deductions
--
-- The expense itself lives on the Expenses record (landlord_expenses, phase
-- P6 — it owns that table and its kinds). This table is payroll's side of the
-- link: which expense pays off which part of which run, so
--   - the expense's posting knows which payroll liability it clears (Dr that
--     liability / Cr Accounts payable, design I1), and
--   - voiding a run finds the unpaid expenses it created, and refuses while
--     one of them has been paid (routes/books.ts).
-- One row per expense; insert-only (an expense is voided on its own record,
-- never unlinked). Values match PAYROLL_EXPENSE_KINDS and
-- PAYROLL_LIABILITY_PARTS in packages/shared/src/booksLedger.ts.
--
-- No money column (the amount is the expense's), so the ledger does not
-- capture this table; it has its journal trigger all the same (keep-everything).
-- Expand-only; safe before the code ships. No backfill needed (new table).
-- Safe drop: the table.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS payroll_run_expenses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id         uuid NOT NULL REFERENCES landlords(id),
  payroll_run_id      uuid NOT NULL REFERENCES payroll_runs(id),
  payroll_run_line_id uuid REFERENCES payroll_run_lines(id),
  expense_id          uuid NOT NULL REFERENCES landlord_expenses(id),
  kind                text NOT NULL,
  liability_role      text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_run_expenses_kind_check CHECK (kind IN ('payroll_net', 'tax_payment')),
  CONSTRAINT payroll_run_expenses_role_check CHECK (liability_role IN (
    'net_pay_payable', 'payroll_federal_withholding', 'payroll_fica', 'payroll_futa',
    'payroll_state_withholding', 'payroll_suta', 'payroll_liabilities')),
  -- A paycheck's take-home pay names its line and clears Net pay payable; a
  -- tax payment is the run's, for one payroll liability.
  CONSTRAINT payroll_run_expenses_shape CHECK (
    (kind = 'payroll_net' AND payroll_run_line_id IS NOT NULL AND liability_role = 'net_pay_payable')
    OR (kind = 'tax_payment' AND payroll_run_line_id IS NULL AND liability_role <> 'net_pay_payable'))
);

CREATE UNIQUE INDEX IF NOT EXISTS payroll_run_expenses_expense ON payroll_run_expenses (expense_id);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_run_expenses_one_net ON payroll_run_expenses (payroll_run_line_id)
  WHERE kind = 'payroll_net';
CREATE UNIQUE INDEX IF NOT EXISTS payroll_run_expenses_one_tax ON payroll_run_expenses (payroll_run_id, liability_role)
  WHERE kind = 'tax_payment';
CREATE INDEX IF NOT EXISTS payroll_run_expenses_run ON payroll_run_expenses (payroll_run_id);

DROP TRIGGER IF EXISTS audit_payroll_run_expenses ON payroll_run_expenses;
CREATE TRIGGER audit_payroll_run_expenses AFTER DELETE OR UPDATE ON payroll_run_expenses
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

COMMENT ON TABLE payroll_run_expenses IS
  '10/12 (Nic, ledger P7): the unpaid expenses an approved payroll run created — take-home pay per paycheck and one tax payment per payroll liability — and which liability each clears (design J3). Insert-only.';
