-- 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P7: THE EMPLOYER'S UNEMPLOYMENT TAXES ARE OWED ON THEIR OWN LINES
--
-- Payroll posts on the pay date (gam-ledger-design-2026-10-12 §6 J3): wages
-- and the employer's taxes as expenses, everything withheld or owed as payroll
-- liabilities. The 10/12 payroll review found the employer's taxes were never
-- recorded per run: Social Security and Medicare were worked out only on the
-- Tax Center, and the federal and state unemployment taxes (FUTA, SUTA) not at
-- all. Each run now records them (migration 20261014200100), and the ledger
-- owes each until it is paid, on its own posting role:
--
--   payroll_futa   2034 Payroll liabilities: federal unemployment tax
--   payroll_suta   2036 Payroll liabilities: state unemployment tax
--
-- (both under 2030 Payroll liabilities, beside 2031 federal withholding, 2032
-- state withholding, 2033 Social Security and Medicare and 2035 Net pay
-- payable).
--
-- The posting-role catalog in SQL (ledger_account_role_type, migration
-- 20261013200200) must know each role, or the CHECKs on ledger_posting_lines
-- and books_account_map refuse it. This ADDS the two roles to the function as
-- it stands (reading its current definition), so a role another phase adds in
-- its own migration is kept whatever order the two run in. Neither is a
-- control role (a bookkeeper may adjust a payroll liability by hand), so
-- ledger_account_role_is_control is unchanged. services/ledgerCoverage.test.ts
-- holds the function equal to LEDGER_ACCOUNT_ROLE_DEFS in
-- packages/shared/src/booksLedger.ts.
--
-- ensureChart seeds the two accounts the next time a company posts (it
-- re-seeds any role a later release adds).
-- Expand-only. No backfill needed.
-- Safe drop: re-create ledger_account_role_type without the two branches
-- (only once no line or map row names either role).

SET LOCAL lock_timeout = '10s';

DO $role$
DECLARE
  def  text;
  r    text;
BEGIN
  FOREACH r IN ARRAY ARRAY['payroll_futa', 'payroll_suta'] LOOP
    def := pg_get_functiondef('ledger_account_role_type(text)'::regprocedure);
    IF position(quote_literal(r) IN def) = 0 THEN
      IF position('ELSE NULL END' IN def) = 0 THEN
        RAISE EXCEPTION 'ledger_account_role_type() no longer ends in ELSE NULL END; add % by hand', r;
      END IF;
      def := replace(def, 'ELSE NULL END', format('WHEN %L THEN %L
    ELSE NULL END', r, 'liability'));
      EXECUTE def;
    END IF;
  END LOOP;
END $role$;

DO $check$
BEGIN
  IF ledger_account_role_type('payroll_futa') IS DISTINCT FROM 'liability'
     OR ledger_account_role_type('payroll_suta') IS DISTINCT FROM 'liability' THEN
    RAISE EXCEPTION 'the unemployment-tax roles did not reach the posting-role catalog';
  END IF;
  IF ledger_account_role_is_control('payroll_futa') OR ledger_account_role_is_control('payroll_suta') THEN
    RAISE EXCEPTION 'the unemployment-tax roles must not be control roles';
  END IF;
END $check$;
