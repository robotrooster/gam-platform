-- S111: pm_monthly_fee_accruals — parallel to monthly_fee_accruals but for
-- third-party PM company plans with fee_type IN ('flat_monthly', 'per_unit').
--
-- Why a separate table instead of extending monthly_fee_accruals: the
-- in-house manager fee uses (property_id, accrual_month) as its idempotency
-- key. PM companies layer onto a per-property assignment but need their
-- own per (property, month, pm_company) keying so that if the property
-- is reassigned mid-month, the prior PM's accrual stays separate from
-- any new one. Two tables, two independent idempotency stories.
--
-- Snapshot fields (fee_type, flat_amount, per_unit_amount, occupied_unit_count,
-- bank_account_id) are stamped at write time so the ledger entry math
-- survives later plan/bank reassignment without retroactive re-routing —
-- same posture as the per-payment allocation snapshot in S110.

CREATE TABLE pm_monthly_fee_accruals (
    id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id           uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
    pm_company_id         uuid NOT NULL REFERENCES pm_companies(id) ON DELETE RESTRICT,
    pm_fee_plan_id        uuid NOT NULL REFERENCES pm_fee_plans(id) ON DELETE RESTRICT,
    accrual_month         date NOT NULL,
    fee_type              text NOT NULL,
    flat_amount           numeric(10,2),
    per_unit_amount       numeric(10,2),
    occupied_unit_count   integer NOT NULL DEFAULT 0,
    total_amount          numeric(10,2) NOT NULL,
    pm_payout_user_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    bank_account_id       uuid REFERENCES user_bank_accounts(id) ON DELETE SET NULL,
    ledger_entry_id       uuid REFERENCES user_balance_ledger(id) ON DELETE SET NULL,
    created_at            timestamp with time zone NOT NULL DEFAULT now(),
    updated_at            timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT pm_monthly_fee_accruals_fee_type_check
      CHECK (fee_type = ANY (ARRAY['flat_monthly', 'per_unit'])),
    CONSTRAINT pm_monthly_fee_accruals_unique
      UNIQUE (property_id, accrual_month, pm_company_id)
);

CREATE INDEX idx_pm_monthly_fee_accruals_property_month
  ON pm_monthly_fee_accruals(property_id, accrual_month DESC);
CREATE INDEX idx_pm_monthly_fee_accruals_pm_company
  ON pm_monthly_fee_accruals(pm_company_id, accrual_month DESC);
