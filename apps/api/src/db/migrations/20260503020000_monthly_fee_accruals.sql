-- S69: monthly fee accrual tracking.
--
-- The 16a allocation rule supports three manager-fee types:
--   - rent_percent: clamped percent of each rent payment, applied at
--     allocation time (S64, already shipped)
--   - flat_monthly_fee: fixed dollar amount per property per month
--   - per_unit_fee: per occupied unit per month
--
-- The latter two are time-based (monthly), not payment-triggered, so they
-- need their own monthly cron. This table records each accrual run so the
-- cron is idempotent — re-running the cron for an already-accrued
-- (property, month) pair is a no-op.
--
-- One row per (property_id, accrual_month) pair. UUID id is the reference_id
-- written onto the corresponding `allocation_manager_fee` row in
-- user_balance_ledger; reference_type='monthly_fee_accrual'.
--
-- accrual_month is a DATE pinned to the first of the month for cleanliness.
-- amount + occupied_unit_count snapshot the values used at accrual time
-- (so changing the rule afterward doesn't retroactively distort history).

CREATE TABLE monthly_fee_accruals (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_id          UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  accrual_month        DATE NOT NULL,
  flat_monthly_fee     NUMERIC(10,2) DEFAULT 0,
  per_unit_fee         NUMERIC(10,2) DEFAULT 0,
  occupied_unit_count  INTEGER NOT NULL DEFAULT 0,
  total_amount         NUMERIC(10,2) NOT NULL,
  manager_user_id      UUID NOT NULL REFERENCES users(id),
  bank_account_id      UUID REFERENCES user_bank_accounts(id),
  ledger_entry_id      UUID REFERENCES user_balance_ledger(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT monthly_fee_accruals_first_of_month
    CHECK (EXTRACT(DAY FROM accrual_month) = 1)
);

CREATE UNIQUE INDEX ux_monthly_fee_accruals_property_month
  ON monthly_fee_accruals(property_id, accrual_month);

CREATE INDEX idx_monthly_fee_accruals_manager
  ON monthly_fee_accruals(manager_user_id, accrual_month DESC);
