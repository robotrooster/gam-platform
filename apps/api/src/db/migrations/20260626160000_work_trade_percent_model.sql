-- S517 / Walkthrough Landlord #29: rebuild work-trade onto the locked
-- "percent-of-invoice" model and wire it into real billing.
--
-- WHY: the S88 subsystem (20260503090000) priced work-trade as a dollar
-- hourly_rate × hours credit, tracked it in work_trade_periods, and NEVER
-- applied it to a tenant's actual invoice — a dead-end calculator. Nic's
-- locked spec (2026-06-26) is different and simpler:
--   * The monthly hours TARGET lives at the PROPERTY level (default 80).
--   * Each verified hour is worth 1/target of the TOTAL invoice
--     (rent + utilities + fees), so a full target month = 100% covered.
--   * Hours come from the existing time clock (work_trade_logs: tenant
--     submits, landlord approves; only approved hours credit).
--   * The credit is applied at invoice generation, reducing what the
--     tenant is actually charged.
--
-- This migration strips the dollar/hour machinery Nic asked to remove,
-- adds the property-level target, and adds the invoice-level credit columns
-- the generator stamps. The credit math itself is in
-- services/workTradeCredit.ts + jobs/invoiceGeneration.ts.
--
-- Safe-drop note: the dropped columns/table held the old dollar model only.
-- No production launch data depends on them (feature was never billed).

-- 1. Property-level monthly hours target (the credit denominator).
ALTER TABLE properties
  ADD COLUMN work_trade_hours_target integer NOT NULL DEFAULT 80,
  ADD CONSTRAINT properties_work_trade_hours_target_pos
    CHECK (work_trade_hours_target > 0);

-- 2. Strip the dollar/hour economics from agreements. An agreement is now
--    just the enrollment (which tenant + unit trades, duties, term, status);
--    all dollar terms are gone — the credit is a percent computed at billing.
ALTER TABLE work_trade_agreements
  DROP CONSTRAINT IF EXISTS work_trade_agreements_trade_type_check;
ALTER TABLE work_trade_agreements
  DROP COLUMN IF EXISTS trade_type,
  DROP COLUMN IF EXISTS hourly_rate,
  DROP COLUMN IF EXISTS weekly_hours,
  DROP COLUMN IF EXISTS market_rent,
  DROP COLUMN IF EXISTS cash_rent,
  DROP COLUMN IF EXISTS trade_credit_max,
  DROP COLUMN IF EXISTS ytd_value,
  DROP COLUMN IF EXISTS flag_1099,
  DROP COLUMN IF EXISTS tax_year;

-- 3. work_trade_logs.credit_value was hours × hourly_rate — meaningless in a
--    percent model (a log's worth depends on the whole month + invoice total,
--    not the log alone). Drop it; approved hours are summed at billing time.
ALTER TABLE work_trade_logs
  DROP COLUMN IF EXISTS credit_value;

-- 4. The whole monthly dollar-reconciliation table is gone. Reconciliation no
--    longer exists: the credit is applied automatically when the monthly
--    invoice generates. Audit of what-was-credited lives on invoices (below).
DROP TABLE IF EXISTS work_trade_periods;

-- 5. Invoice-level credit record. The generator stamps these; total_amount is
--    written net of the credit (subtotals stay GROSS for the record). The FK
--    links the invoice back to the agreement that drove the credit.
ALTER TABLE invoices
  ADD COLUMN work_trade_credit_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN work_trade_credit_hours  numeric(8,2)  NOT NULL DEFAULT 0,
  ADD COLUMN work_trade_agreement_id  uuid REFERENCES work_trade_agreements(id) ON DELETE SET NULL,
  ADD CONSTRAINT invoices_work_trade_credit_nonneg
    CHECK (work_trade_credit_amount >= 0 AND work_trade_credit_hours >= 0);
