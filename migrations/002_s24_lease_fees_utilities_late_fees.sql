-- Migration 002: S24 - Lease Fees, Utilities, Late Fees, Deposits, Timezone
-- Branch: feature/gam-books
-- Session: S24 (Launch Arc 1/8)
-- Applies schema foundation for S25-S31 launch arc.

BEGIN;

-- ============================================================================
-- 1. TIMEZONE on properties
-- ============================================================================
ALTER TABLE properties ADD COLUMN timezone text;
UPDATE properties SET timezone = 'America/Phoenix';
ALTER TABLE properties ALTER COLUMN timezone SET NOT NULL;
ALTER TABLE properties ALTER COLUMN timezone SET DEFAULT 'America/Phoenix';

-- ============================================================================
-- 2. LATE FEE BILLING SOURCE OF TRUTH on properties
-- ============================================================================
ALTER TABLE properties ADD COLUMN late_fee_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE properties ADD COLUMN late_fee_grace_days integer NOT NULL DEFAULT 5;
ALTER TABLE properties ADD COLUMN late_fee_initial_amount numeric NOT NULL DEFAULT 15.00;
ALTER TABLE properties ADD COLUMN late_fee_initial_type text NOT NULL DEFAULT 'flat'
  CHECK (late_fee_initial_type IN ('flat', 'percent_of_rent'));
ALTER TABLE properties ADD COLUMN late_fee_accrual_amount numeric;
ALTER TABLE properties ADD COLUMN late_fee_accrual_type text
  CHECK (late_fee_accrual_type IN ('flat', 'percent_of_rent'));
ALTER TABLE properties ADD COLUMN late_fee_accrual_period text
  CHECK (late_fee_accrual_period IN ('daily', 'weekly', 'monthly'));
ALTER TABLE properties ADD COLUMN late_fee_cap_amount numeric;
ALTER TABLE properties ADD COLUMN late_fee_cap_type text
  CHECK (late_fee_cap_type IN ('flat', 'percent_of_rent'));

-- ============================================================================
-- 3. LATE FEE SIGNED-LEASE SNAPSHOTS on leases
-- ============================================================================
ALTER TABLE leases RENAME COLUMN late_fee_amount TO late_fee_initial_amount;
ALTER TABLE leases ADD COLUMN late_fee_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE leases ADD COLUMN late_fee_initial_type text NOT NULL DEFAULT 'flat'
  CHECK (late_fee_initial_type IN ('flat', 'percent_of_rent'));
ALTER TABLE leases ADD COLUMN late_fee_accrual_amount numeric;
ALTER TABLE leases ADD COLUMN late_fee_accrual_type text
  CHECK (late_fee_accrual_type IN ('flat', 'percent_of_rent'));
ALTER TABLE leases ADD COLUMN late_fee_accrual_period text
  CHECK (late_fee_accrual_period IN ('daily', 'weekly', 'monthly'));
ALTER TABLE leases ADD COLUMN late_fee_cap_amount numeric;
ALTER TABLE leases ADD COLUMN late_fee_cap_type text
  CHECK (late_fee_cap_type IN ('flat', 'percent_of_rent'));

-- ============================================================================
-- 4. DEPOSIT HANDLING + INTEREST CONFIG on properties
-- ============================================================================
ALTER TABLE properties ADD COLUMN deposit_handling_mode text NOT NULL DEFAULT 'landlord_held'
  CHECK (deposit_handling_mode IN ('gam_escrow', 'landlord_held'));
ALTER TABLE properties ADD COLUMN deposit_interest_rate_annual numeric;
ALTER TABLE properties ADD COLUMN deposit_interest_accrual_method text
  CHECK (deposit_interest_accrual_method IN ('simple', 'compound'));
ALTER TABLE properties ADD COLUMN deposit_interest_payment_cadence text
  CHECK (deposit_interest_payment_cadence IN ('annual', 'at_return', 'on_anniversary'));

-- ============================================================================
-- 5. HELD_BY snapshot on security_deposits
-- ============================================================================
ALTER TABLE security_deposits ADD COLUMN held_by text
  CHECK (held_by IN ('gam_escrow', 'landlord'));
UPDATE security_deposits SET held_by = 'landlord' WHERE held_by IS NULL;
ALTER TABLE security_deposits ALTER COLUMN held_by SET NOT NULL;

-- ============================================================================
-- 6. LEASE_FEES table
-- ============================================================================
CREATE TABLE lease_fees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id uuid NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  fee_type text NOT NULL CHECK (fee_type IN (
    'pet_deposit', 'key_deposit', 'cleaning_deposit',
    'move_in_fee', 'cleaning_fee', 'pet_fee', 'application_fee',
    'amenity_fee', 'hoa_transfer_fee', 'lease_prep_fee',
    'pet_rent', 'parking_rent', 'storage_rent', 'amenity_fee_monthly',
    'trash_fee', 'pest_control_fee', 'technology_fee',
    'last_month_rent', 'early_termination_fee', 'other_fee'
  )),
  amount numeric NOT NULL CHECK (amount >= 0),
  is_refundable boolean NOT NULL,
  due_timing text NOT NULL CHECK (due_timing IN ('move_in', 'monthly_ongoing', 'move_out', 'other')),
  description text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE INDEX idx_lease_fees_lease_id ON lease_fees(lease_id);
CREATE INDEX idx_lease_fees_fee_type ON lease_fees(fee_type);

-- ============================================================================
-- 7. UTILITY_METERS table
-- ============================================================================
CREATE TABLE utility_meters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  utility_type text NOT NULL CHECK (utility_type IN ('water', 'gas', 'electric', 'sewer', 'trash')),
  label text NOT NULL,
  billing_method text NOT NULL CHECK (billing_method IN ('submeter', 'rubs', 'master_bill_to_landlord')),
  rate_per_unit numeric,
  base_fee numeric NOT NULL DEFAULT 0,
  rubs_allocation_method text CHECK (rubs_allocation_method IN ('occupant_count', 'sqft', 'bedrooms', 'equal_split')),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CHECK (
    (billing_method = 'rubs' AND rubs_allocation_method IS NOT NULL) OR
    (billing_method != 'rubs' AND rubs_allocation_method IS NULL)
  )
);
CREATE INDEX idx_utility_meters_property_id ON utility_meters(property_id);

-- ============================================================================
-- 8. UTILITY_METER_UNITS join
-- ============================================================================
CREATE TABLE utility_meter_units (
  meter_id uuid NOT NULL REFERENCES utility_meters(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  created_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (meter_id, unit_id)
);
CREATE INDEX idx_utility_meter_units_unit_id ON utility_meter_units(unit_id);

-- ============================================================================
-- 9. UTILITY_METER_READINGS table
-- ============================================================================
CREATE TABLE utility_meter_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meter_id uuid NOT NULL REFERENCES utility_meters(id) ON DELETE CASCADE,
  reading_date date NOT NULL,
  reading_value numeric NOT NULL,
  billing_cycle_month date NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamp with time zone DEFAULT now(),
  UNIQUE (meter_id, billing_cycle_month)
);
CREATE INDEX idx_utility_meter_readings_meter_id ON utility_meter_readings(meter_id);
CREATE INDEX idx_utility_meter_readings_billing_cycle ON utility_meter_readings(billing_cycle_month);

-- ============================================================================
-- 10. LEASE_UTILITY_ASSIGNMENTS table
-- ============================================================================
CREATE TABLE lease_utility_assignments (
  lease_id uuid NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  meter_id uuid NOT NULL REFERENCES utility_meters(id) ON DELETE CASCADE,
  created_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (lease_id, meter_id)
);
CREATE INDEX idx_lease_utility_assignments_meter_id ON lease_utility_assignments(meter_id);

-- ============================================================================
-- 11. PAYMENTS.parent_payment_id
-- ============================================================================
ALTER TABLE payments ADD COLUMN parent_payment_id uuid REFERENCES payments(id);
CREATE INDEX idx_payments_parent_payment_id ON payments(parent_payment_id);

-- ============================================================================
-- 12. DROP old utility_bills (0 rows confirmed)
-- ============================================================================
DROP TABLE utility_bills;

-- ============================================================================
-- 13. WIDEN lease_column CHECK on lease_template_fields only
-- lease_document_fields CHECK absence flagged to deferred for audit.
-- ============================================================================
ALTER TABLE lease_template_fields DROP CONSTRAINT lease_template_fields_lease_column_check;

ALTER TABLE lease_template_fields ADD CONSTRAINT lease_template_fields_lease_column_check
CHECK (lease_column IS NULL OR lease_column = ANY (ARRAY[
  'tenant_name','tenant_email','landlord_name',
  'unit_number','property_name','property_address',
  'tenant_signature','landlord_signature','tenant_initial','landlord_initial','date_signed',
  'rent_amount','start_date','end_date','security_deposit',
  'rent_due_day','lease_type','auto_renew','auto_renew_mode',
  'notice_days_required','expiration_notice_days',
  'late_fee_grace_days',
  'late_fee_initial_flat','late_fee_initial_percent',
  'late_fee_accrual_flat_daily','late_fee_accrual_flat_weekly','late_fee_accrual_flat_monthly',
  'late_fee_accrual_percent_daily','late_fee_accrual_percent_weekly','late_fee_accrual_percent_monthly',
  'late_fee_cap_flat','late_fee_cap_percent',
  'pet_deposit','key_deposit','cleaning_deposit',
  'move_in_fee','cleaning_fee','pet_fee','application_fee',
  'amenity_fee','hoa_transfer_fee','lease_prep_fee',
  'pet_rent','parking_rent','storage_rent','amenity_fee_monthly',
  'trash_fee','pest_control_fee','technology_fee',
  'last_month_rent','early_termination_fee','other_fee',
  'utility_water_responsibility','utility_gas_responsibility',
  'utility_electric_responsibility','utility_sewer_responsibility',
  'utility_trash_responsibility',
  'custom_text'
]));

-- ============================================================================
-- 14. DROP nightly and weekly from leases_lease_type_check
-- ============================================================================
ALTER TABLE leases DROP CONSTRAINT leases_lease_type_check;
ALTER TABLE leases ADD CONSTRAINT leases_lease_type_check
  CHECK (lease_type = ANY (ARRAY['month_to_month'::text, 'fixed_term'::text, 'nnn_commercial'::text]));

COMMIT;
