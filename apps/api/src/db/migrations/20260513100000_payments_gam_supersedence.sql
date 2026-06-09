-- S261: GAM-supersedence routing — capture, on every inbound PI, how
-- much of the gross was redirected to satisfy older GAM-owed debts
-- (FlexDeposit defaulted installments + accelerated balance, FlexCharge
-- unpaid statements, FlexPay defaulted advances, custody charges).
--
-- The boost is computed at PI creation by services/supersedence.ts and
-- baked into application_fee_amount (destination charges) or into the
-- gross pull amount (platform-only PIs for FlexDeposit / FlexCharge /
-- FlexPay product pulls). On webhook settle, applyTenantSupersedence
-- reads gam_supersedence_amount + breakdown and marks the satisfied
-- rows paid.
--
-- No backfill needed — defaults handle pre-S261 payments cleanly.
-- Audit-only columns; no FK churn.

ALTER TABLE public.payments
  ADD COLUMN gam_supersedence_amount     NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN gam_supersedence_breakdown  JSONB,
  ADD COLUMN gam_supersedence_applied_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_gam_supersedence_amount_nonneg
    CHECK (gam_supersedence_amount >= 0);

COMMENT ON COLUMN public.payments.gam_supersedence_amount IS
  'S261: dollar amount of this payment redirected to satisfy older GAM-owed debts. Captured at PI creation, distributed FIFO on settlement.';

COMMENT ON COLUMN public.payments.gam_supersedence_breakdown IS
  'S261: ordered FIFO list of which GAM debts this payment satisfied. Shape: [{source, ref_id, amount, satisfied_at}]. Source ∈ flexdeposit_installment | flexdeposit_acceleration | flexcharge_statement | flexpay_advance | custody_charge. NULL until applyTenantSupersedence runs.';

COMMENT ON COLUMN public.payments.gam_supersedence_applied_at IS
  'S261: idempotency stamp — set once when applyTenantSupersedence completes for this payment. NULL means the boost has not yet been distributed.';
