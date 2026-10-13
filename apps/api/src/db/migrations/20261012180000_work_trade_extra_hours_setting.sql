-- 10/12 (Nic): WHAT EXTRA HOURS DO — THE LANDLORD PICKS PER AGREEMENT.
--
-- "He may be doing more work than what the work trade covers. And instead of
-- giving him credit ahead for his rent, it may be compensation on top of the
-- rent. So maybe we need a way to track an hourly rate for additional hours so
-- that the landlord can, you know, supplement a check through payroll or 1099."
--
-- Until now every approved hour beyond what a month needed (after any carried
-- shortfall) went to banked_hours, uncapped. That stays the default ('bank').
-- 'pay' records those hours at month close as PAYABLE extra hours at the rate
-- set here, paid by payroll (W-2) or a contractor payment (1099) — see
-- work_trade_extra_hours. Values match @gam/shared WORK_TRADE_EXTRA_HOURS_MODES
-- and WORK_TRADE_EXTRA_PAY_METHODS.
--
-- The rate and pay method are KEPT when a landlord switches back to 'bank', so
-- switching to 'pay' again restores them; they are required only while 'pay'.
--
-- Expand-only. No backfill needed: every existing agreement takes the default
-- 'bank', which is exactly what the month close did before.
ALTER TABLE work_trade_agreements
  ADD COLUMN IF NOT EXISTS extra_hours_mode text NOT NULL DEFAULT 'bank',
  ADD COLUMN IF NOT EXISTS extra_hours_rate numeric(10,2),
  ADD COLUMN IF NOT EXISTS extra_hours_pay_method text;

ALTER TABLE work_trade_agreements
  ADD CONSTRAINT work_trade_agreements_extra_hours_mode_check
    CHECK (extra_hours_mode IN ('bank', 'pay')),
  ADD CONSTRAINT work_trade_agreements_extra_hours_rate_positive
    CHECK (extra_hours_rate IS NULL OR extra_hours_rate > 0),
  ADD CONSTRAINT work_trade_agreements_extra_hours_pay_method_check
    CHECK (extra_hours_pay_method IS NULL OR extra_hours_pay_method IN ('payroll_w2', 'contractor_1099')),
  ADD CONSTRAINT work_trade_agreements_extra_hours_pay_needs_terms
    CHECK (extra_hours_mode = 'bank' OR (extra_hours_rate IS NOT NULL AND extra_hours_pay_method IS NOT NULL));

COMMENT ON COLUMN work_trade_agreements.extra_hours_mode IS
  '10/12 (Nic): what approved hours beyond what a month needs (after any carried shortfall) do. bank = banked toward future months (the default, and the only behavior before 10/12); pay = recorded at month close as payable extra hours (work_trade_extra_hours) at extra_hours_rate. Only an agreement that tracks hours pays extra hours.';
COMMENT ON COLUMN work_trade_agreements.extra_hours_rate IS
  '10/12: the hourly rate for PAID extra hours. The tenant may see it for paid extra hours; the trade hours themselves never carry a rate for the tenant (S643). Kept when switching back to bank.';
COMMENT ON COLUMN work_trade_agreements.extra_hours_pay_method IS
  '10/12: how paid extra hours are paid — payroll_w2 (Payroll (W-2)) or contractor_1099 (Contractor payment (1099)).';
