-- 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P7: EVERY PAYROLL RUN RECORDS THE EMPLOYER'S TAXES
--
-- Payroll posts on the pay date (gam-ledger-design-2026-10-12 §6 J3): wages
-- (5120) and the employer's taxes (5125) as expenses; everything withheld and
-- everything the employer owes as payroll liabilities; the take-home pay as
-- Net pay payable. The 10/12 payroll review found the run recorded only what
-- was WITHHELD from the employee. The employer's own taxes were never stored:
--   - Social Security and Medicare matches were worked out on the Tax Center
--     from the year's totals, never per paycheck, so nothing could post them;
--   - the federal and state unemployment taxes (FUTA, SUTA) were nowhere.
--
-- payroll_run_lines (one paycheck)
--   + employer_ss_tax        the employer's Social Security: 6.2% up to the
--                            year's wage base — the same as the employee's
--                            (GAM works it out; booksEmployerFica, shared)
--   + employer_medicare_tax  the employer's Medicare: 1.45% of the whole check
--                            (the 0.9% Additional Medicare Tax is the
--                            employee's alone)
--   + futa_tax, suta_tax     the employer's federal and state unemployment tax
--                            on this check, as the person running payroll
--                            enters them (S592: GAM computes only what is the
--                            same fixed rate for every employer; an
--                            unemployment rate depends on the employer's state
--                            and record). $0 when nothing is entered.
-- payroll_runs
--   + total_employer_ss, total_employer_medicare, total_futa, total_suta
--     the run's totals of the four, like the existing totals.
--   + status CHECK: 'draft', 'approved', 'voided' (BOOKS_PAYROLL_RUN_STATUSES;
--     the only values routes/books.ts writes).
--
-- Money is never negative here (CHECKs).
-- The ledger capture of both tables widens to the new columns (the payroll
-- projector reads them), the same list as LEDGER_CAPTURE_COLUMNS in
-- packages/shared/src/booksLedger.ts (services/ledgerCoverage.test.ts holds
-- them equal). Re-installing a capture replaces its three trigger bodies only
-- (ledger_install_capture, 20261013200600). Both tables keep their journal
-- trigger: payroll_runs had one (audit_payroll_runs) and payroll_run_lines got
-- one in 20261013100000.
--
-- BACKFILL (production had 0 payroll runs on 10/12; demo and test databases
-- have some): an existing line's employer Social Security is its employee
-- Social Security (same rate, same wage base, to the cent) and its employer
-- Medicare is 1.45% of its gross — exactly what the Tax Center worked out for
-- them. Unemployment taxes were never entered, so they stay $0. Each run's
-- totals are re-added from its lines.
-- Expand-only; safe before the code ships (the old code writes the defaults,
-- $0, until it ships — the Tax Center keeps reading the same figures).
-- Safe drop: the eight columns, the three CHECKs, and the two captures
-- re-installed with their 20261013200600 lists.

SET LOCAL lock_timeout = '10s';

ALTER TABLE payroll_run_lines
  ADD COLUMN IF NOT EXISTS employer_ss_tax       numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS employer_medicare_tax numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS futa_tax              numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS suta_tax              numeric(10,2) NOT NULL DEFAULT 0;

ALTER TABLE payroll_run_lines
  ADD CONSTRAINT payroll_run_lines_employer_taxes_nonneg
  CHECK (employer_ss_tax >= 0 AND employer_medicare_tax >= 0 AND futa_tax >= 0 AND suta_tax >= 0);

ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS total_employer_ss       numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_employer_medicare numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_futa              numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_suta              numeric(12,2) NOT NULL DEFAULT 0;

ALTER TABLE payroll_runs
  ADD CONSTRAINT payroll_runs_employer_taxes_nonneg
  CHECK (total_employer_ss >= 0 AND total_employer_medicare >= 0 AND total_futa >= 0 AND total_suta >= 0);

ALTER TABLE payroll_runs
  ADD CONSTRAINT payroll_runs_status_check CHECK (status IN ('draft', 'approved', 'voided')) NOT VALID;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM payroll_runs WHERE status NOT IN ('draft', 'approved', 'voided')) THEN
    ALTER TABLE payroll_runs VALIDATE CONSTRAINT payroll_runs_status_check;
  ELSE
    RAISE NOTICE 'payroll_runs_status_check left NOT VALID: some existing run has another status';
  END IF;
END $$;

-- ── Backfill: the employer's FICA on every line written before today ───────
UPDATE payroll_run_lines
   SET employer_ss_tax = ss_tax,
       employer_medicare_tax = round(gross_pay * 0.0145, 2)
 WHERE employer_ss_tax = 0 AND employer_medicare_tax = 0 AND (ss_tax > 0 OR gross_pay > 0);

UPDATE payroll_runs r
   SET total_employer_ss = t.ss, total_employer_medicare = t.med, total_futa = t.futa, total_suta = t.suta
  FROM (SELECT run_id, sum(employer_ss_tax) AS ss, sum(employer_medicare_tax) AS med,
               sum(futa_tax) AS futa, sum(suta_tax) AS suta
          FROM payroll_run_lines GROUP BY run_id) t
 WHERE t.run_id = r.id
   AND (r.total_employer_ss, r.total_employer_medicare, r.total_futa, r.total_suta)
       IS DISTINCT FROM (t.ss, t.med, t.futa, t.suta);

-- ── The ledger reads the new columns: widen both captures ───────────────────
SELECT ledger_install_capture('payroll_runs',
  ARRAY['landlord_id', 'business_id', 'pay_date', 'status', 'total_gross', 'total_federal_tax', 'total_state_tax',
        'total_ss', 'total_medicare', 'total_net', 'approved_at', 'voided_at',
        'total_employer_ss', 'total_employer_medicare', 'total_futa', 'total_suta'],
  $k$SELECT 'payroll_run'::text, r.id::text, COALESCE(r.landlord_id, r.business_id)$k$);

SELECT ledger_install_capture('payroll_run_lines',
  ARRAY['run_id', 'employee_id', 'gross_pay', 'federal_tax', 'state_tax', 'ss_tax', 'medicare_tax',
        'other_deductions', 'net_pay',
        'employer_ss_tax', 'employer_medicare_tax', 'futa_tax', 'suta_tax'],
  $k$SELECT 'payroll_run'::text, r.run_id::text, (SELECT COALESCE(pr.landlord_id, pr.business_id) FROM payroll_runs pr WHERE pr.id = r.run_id)$k$);

SELECT ledger_check_capture();

COMMENT ON COLUMN payroll_run_lines.employer_ss_tax IS
  '10/12 (Nic, ledger P7): the employer''s Social Security on this check — 6.2% up to the year''s wage base, equal to the employee''s.';
COMMENT ON COLUMN payroll_run_lines.employer_medicare_tax IS
  '10/12 (Nic, ledger P7): the employer''s Medicare on this check — 1.45% of gross (no Additional Medicare Tax).';
COMMENT ON COLUMN payroll_run_lines.futa_tax IS
  '10/12 (Nic, ledger P7): the employer''s federal unemployment tax on this check, as entered when the run was calculated.';
COMMENT ON COLUMN payroll_run_lines.suta_tax IS
  '10/12 (Nic, ledger P7): the employer''s state unemployment tax on this check, as entered when the run was calculated.';
