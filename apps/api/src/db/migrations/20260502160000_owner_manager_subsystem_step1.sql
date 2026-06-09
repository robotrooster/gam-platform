-- 16a Step 1: schema foundation for owner/manager + allocation + ledger + withdrawal
-- Adds owner/manager pointers on properties, allocation rule storage,
-- per-user balance ledger, and reshapes disbursements into user-keyed withdrawals.

-- ============================================================================
-- 1. properties: add owner_user_id + managed_by_user_id
-- ============================================================================

ALTER TABLE properties
  ADD COLUMN owner_user_id UUID,
  ADD COLUMN managed_by_user_id UUID;

UPDATE properties p
   SET owner_user_id = l.user_id,
       managed_by_user_id = l.user_id
  FROM landlords l
 WHERE l.id = p.landlord_id;

ALTER TABLE properties
  ALTER COLUMN owner_user_id SET NOT NULL,
  ALTER COLUMN managed_by_user_id SET NOT NULL;

ALTER TABLE properties
  ADD CONSTRAINT properties_owner_user_id_fkey
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT properties_managed_by_user_id_fkey
    FOREIGN KEY (managed_by_user_id) REFERENCES users(id) ON DELETE RESTRICT;

CREATE INDEX idx_properties_owner_user ON properties(owner_user_id);
CREATE INDEX idx_properties_managed_by_user ON properties(managed_by_user_id);

-- ============================================================================
-- 2. property_allocation_rules (1:1 with properties)
-- ============================================================================

CREATE TABLE property_allocation_rules (
  property_id UUID PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,

  rent_percent          NUMERIC(5,2),
  rent_percent_floor    NUMERIC(10,2),
  rent_percent_ceiling  NUMERIC(10,2),

  flat_monthly_fee      NUMERIC(10,2),

  per_unit_fee          NUMERIC(10,2),

  placement_fee_type    TEXT,
  placement_fee_value   NUMERIC(10,2),

  maintenance_markup_percent NUMERIC(5,2),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT property_allocation_rules_placement_fee_type_check
    CHECK (placement_fee_type IS NULL OR placement_fee_type IN ('flat', 'percent_of_first_month')),
  CONSTRAINT property_allocation_rules_placement_fee_paired
    CHECK ((placement_fee_type IS NULL) = (placement_fee_value IS NULL))
);

CREATE TRIGGER trg_property_allocation_rules_updated_at
  BEFORE UPDATE ON property_allocation_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- 3. user_balance_ledger (per-user, reserve_fund_ledger pattern)
-- ============================================================================

CREATE TABLE user_balance_ledger (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  type          TEXT NOT NULL,
  amount        NUMERIC(10,2) NOT NULL,
  balance_after NUMERIC(10,2) NOT NULL,
  reference_id  UUID,
  reference_type TEXT,
  property_id   UUID REFERENCES properties(id) ON DELETE SET NULL,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT user_balance_ledger_type_check
    CHECK (type IN (
      'allocation_owner_share',
      'allocation_manager_fee',
      'placement_fee',
      'maintenance_markup',
      'withdrawal_auto',
      'withdrawal_manual',
      'withdrawal_fee',
      'adjustment'
    ))
);

CREATE INDEX idx_user_balance_ledger_user
  ON user_balance_ledger(user_id);
CREATE INDEX idx_user_balance_ledger_user_created
  ON user_balance_ledger(user_id, created_at DESC);
CREATE INDEX idx_user_balance_ledger_reference
  ON user_balance_ledger(reference_id) WHERE reference_id IS NOT NULL;
CREATE INDEX idx_user_balance_ledger_property
  ON user_balance_ledger(property_id) WHERE property_id IS NOT NULL;

-- ============================================================================
-- 4. disbursements reshape: external withdrawals from user GAM balance
-- ============================================================================

ALTER TABLE disbursements
  ADD COLUMN user_id      UUID,
  ADD COLUMN trigger_type TEXT,
  ADD COLUMN fee_charged  NUMERIC(10,2) DEFAULT 0;

ALTER TABLE disbursements
  ADD CONSTRAINT disbursements_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE disbursements
  ALTER COLUMN landlord_id DROP NOT NULL,
  ALTER COLUMN unit_count  DROP NOT NULL,
  ALTER COLUMN target_date DROP NOT NULL;

ALTER TABLE disbursements
  ADD CONSTRAINT disbursements_trigger_type_check
    CHECK (trigger_type IS NULL OR trigger_type IN ('auto_friday', 'manual_on_demand', 'otp_legacy'));

CREATE INDEX idx_disbursements_user
  ON disbursements(user_id) WHERE user_id IS NOT NULL;
