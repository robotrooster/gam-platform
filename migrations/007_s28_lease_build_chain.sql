-- ============================================================================
-- Migration 007 — S28 lease build chain
-- ============================================================================
--
-- Two changes scoped to wiring the signed-document → live-lease pipeline:
--
--   1. lease_utility_responsibilities (new table)
--      Captures per-utility legal responsibility from the signed lease
--      document. Separated from lease_utility_assignments which is a pure
--      meter-pointer table for operational meter selection. Single row per
--      (lease, utility_type).
--
--   2. lease_document_fields.lease_column CHECK
--      Enforces the 57-value LEASE_COLUMNS taxonomy from packages/shared at
--      write time. Catches typos, deprecated tag names, and shared-vs-DB
--      drift. NULL still allowed for unbound fields.
--
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. lease_utility_responsibilities
-- ----------------------------------------------------------------------------
CREATE TABLE lease_utility_responsibilities (
  lease_id           uuid        NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  utility_type       text        NOT NULL,
  tenant_responsible boolean     NOT NULL,
  created_at         timestamptz DEFAULT NOW(),
  PRIMARY KEY (lease_id, utility_type),
  CONSTRAINT lease_utility_responsibilities_utility_type_check
    CHECK (utility_type IN ('water', 'gas', 'electric', 'sewer', 'trash'))
);

CREATE INDEX idx_lease_utility_responsibilities_lease_id
  ON lease_utility_responsibilities(lease_id);

-- ----------------------------------------------------------------------------
-- 2. lease_document_fields.lease_column CHECK
-- ----------------------------------------------------------------------------
ALTER TABLE lease_document_fields
  ADD CONSTRAINT lease_document_fields_lease_column_check
  CHECK (lease_column IS NULL OR lease_column IN (
    -- identity
    'tenant_name', 'tenant_email', 'landlord_name',
    'unit_number', 'property_name', 'property_address',
    -- signature
    'tenant_signature', 'landlord_signature',
    'tenant_initial', 'landlord_initial', 'date_signed',
    -- writable core
    'rent_amount', 'start_date', 'end_date', 'security_deposit',
    'rent_due_day', 'lease_type', 'auto_renew', 'auto_renew_mode',
    'notice_days_required', 'expiration_notice_days',
    -- writable late fee snapshot
    'late_fee_grace_days',
    'late_fee_initial_flat', 'late_fee_initial_percent',
    'late_fee_accrual_flat_daily', 'late_fee_accrual_flat_weekly', 'late_fee_accrual_flat_monthly',
    'late_fee_accrual_percent_daily', 'late_fee_accrual_percent_weekly', 'late_fee_accrual_percent_monthly',
    'late_fee_cap_flat', 'late_fee_cap_percent',
    -- fee_row
    'pet_deposit', 'key_deposit', 'cleaning_deposit',
    'move_in_fee', 'cleaning_fee', 'pet_fee', 'application_fee',
    'amenity_fee', 'hoa_transfer_fee', 'lease_prep_fee',
    'pet_rent', 'parking_rent', 'storage_rent', 'amenity_fee_monthly',
    'trash_fee', 'pest_control_fee', 'technology_fee',
    'last_month_rent', 'early_termination_fee', 'other_fee',
    -- utility_row
    'utility_water_responsibility', 'utility_gas_responsibility',
    'utility_electric_responsibility', 'utility_sewer_responsibility',
    'utility_trash_responsibility',
    -- free-text escape
    'custom_text'
  ));

COMMIT;
