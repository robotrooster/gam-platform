-- 16a Step 2 schema: banking-fee payer, platform revenue ledger, processing rate card
-- Prerequisites for executeRentAllocation engine.
-- All margin-revealing fields (stripe_cost_*, banking_spread) are admin-only at API layer.

-- ============================================================================
-- 1. property_allocation_rules: banking fee payer mode
-- ============================================================================

ALTER TABLE property_allocation_rules
  ADD COLUMN banking_fee_payer TEXT NOT NULL DEFAULT 'tenant';

ALTER TABLE property_allocation_rules
  ADD CONSTRAINT property_allocation_rules_banking_fee_payer_check
    CHECK (banking_fee_payer IN ('landlord', 'tenant'));

-- ============================================================================
-- 2. platform_revenue_ledger (GAM's own balance — admin-only at API)
-- ============================================================================

CREATE TABLE platform_revenue_ledger (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type           TEXT NOT NULL,
  amount         NUMERIC(10,2) NOT NULL,
  balance_after  NUMERIC(10,2) NOT NULL,
  reference_id   UUID,
  reference_type TEXT,
  property_id    UUID REFERENCES properties(id) ON DELETE SET NULL,
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT platform_revenue_ledger_type_check
    CHECK (type IN (
      'banking_spread',
      'manual_withdrawal_fee',
      'placement_fee_share',
      'adjustment'
    ))
);

CREATE INDEX idx_platform_revenue_ledger_created
  ON platform_revenue_ledger(created_at DESC);
CREATE INDEX idx_platform_revenue_ledger_reference
  ON platform_revenue_ledger(reference_id) WHERE reference_id IS NOT NULL;
CREATE INDEX idx_platform_revenue_ledger_property
  ON platform_revenue_ledger(property_id) WHERE property_id IS NOT NULL;

-- Idempotency guard: same payment cannot generate two rows of the same type
CREATE UNIQUE INDEX ux_platform_revenue_ledger_idempotent
  ON platform_revenue_ledger(reference_id, reference_type, type)
  WHERE reference_id IS NOT NULL;

-- ============================================================================
-- 3. user_balance_ledger: idempotency guard (parallel to platform ledger)
-- ============================================================================

CREATE UNIQUE INDEX ux_user_balance_ledger_idempotent
  ON user_balance_ledger(reference_id, reference_type, type)
  WHERE reference_id IS NOT NULL;

-- ============================================================================
-- 4. platform_processing_rates (effective-dated rate card)
-- ============================================================================

CREATE TABLE platform_processing_rates (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_method           TEXT NOT NULL,
  customer_facing_flat     NUMERIC(10,4),
  customer_facing_percent  NUMERIC(6,4),
  stripe_cost_flat         NUMERIC(10,4),
  stripe_cost_percent      NUMERIC(6,4),
  effective_from           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_until          TIMESTAMPTZ,
  notes                    TEXT,
  created_at               TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT platform_processing_rates_payment_method_check
    CHECK (payment_method IN ('ach', 'card_credit', 'card_debit')),
  CONSTRAINT platform_processing_rates_effective_window_check
    CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE INDEX idx_platform_processing_rates_active
  ON platform_processing_rates(payment_method, effective_from DESC);

-- Only one open-ended (effective_until IS NULL) row per payment_method
CREATE UNIQUE INDEX ux_platform_processing_rates_active_per_method
  ON platform_processing_rates(payment_method)
  WHERE effective_until IS NULL;

-- Seed: one open row per method, all rate fields NULL.
-- executeRentAllocation throws if any rate field is NULL → no silent zero margin.
-- Update via UPDATE statements when Stripe pricing finalized.
INSERT INTO platform_processing_rates (payment_method, notes) VALUES
  ('ach',         'Placeholder. Set rates before enabling rent allocation.'),
  ('card_credit', 'Placeholder. Set rates before enabling rent allocation.'),
  ('card_debit',  'Placeholder. Set rates before enabling rent allocation.');
