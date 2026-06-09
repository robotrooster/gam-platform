-- S195: phase 1 of leases.security_deposit → lease_fees deprecation.
--
-- Adds 'security_deposit' as a valid fee_type on lease_fees + the
-- mirror enum on property_fee_schedules (kept in lockstep with
-- lease_fees per existing convention). Backfills existing
-- leases.security_deposit > 0 values into lease_fees rows so the new
-- catalog is the source of truth from the migration's commit
-- forward.
--
-- Phase 1 (this session): migration + dual-write at all writer sites.
-- Readers continue to use leases.security_deposit (legacy column);
-- nothing breaks.
--
-- Phase 2 (S196+): switch readers to lease_fees, stop dual-writing,
-- drop leases.security_deposit column, remove from
-- WRITABLE_LEASE_COLUMN_SPECS in @gam/shared.
--
-- Why this matters: lease_fees is the canonical "every dollar amount
-- the lease stipulates" catalog (cleaning_fee, late_fee_initial_amount,
-- pet_fee, application_fee, etc.). leases.security_deposit was the
-- one stipulated-amount column NOT in the catalog — duplicative,
-- inconsistent surface for landlord-side fee management, and forces
-- the deposit-return + move-in-invoice services to special-case the
-- column. Folding it into lease_fees unifies the model.
--
-- Backfill skips rows where a security_deposit lease_fee already
-- exists (idempotent re-runs); skips zero-value rows (no point
-- creating $0 line items).

ALTER TABLE lease_fees DROP CONSTRAINT lease_fees_fee_type_check;
ALTER TABLE lease_fees ADD CONSTRAINT lease_fees_fee_type_check
  CHECK (fee_type = ANY (ARRAY[
    'security_deposit'::text,
    'pet_deposit'::text,
    'key_deposit'::text,
    'cleaning_deposit'::text,
    'move_in_fee'::text,
    'cleaning_fee'::text,
    'pet_fee'::text,
    'application_fee'::text,
    'amenity_fee'::text,
    'hoa_transfer_fee'::text,
    'lease_prep_fee'::text,
    'pet_rent'::text,
    'parking_rent'::text,
    'storage_rent'::text,
    'amenity_fee_monthly'::text,
    'trash_fee'::text,
    'pest_control_fee'::text,
    'technology_fee'::text,
    'last_month_rent'::text,
    'early_termination_fee'::text,
    'other_fee'::text
  ]));

-- Mirror on property_fee_schedules: keep the two enums identical so
-- the landlord-side fee-template management surface can reuse the
-- same selector. property_fee_schedules drives the move-in /
-- monthly-ongoing / move-out catalog at the property level; the
-- per-lease lease_fees rows are stamped from it at lease creation.
ALTER TABLE property_fee_schedules DROP CONSTRAINT property_fee_schedules_fee_type_check;
ALTER TABLE property_fee_schedules ADD CONSTRAINT property_fee_schedules_fee_type_check
  CHECK (fee_type = ANY (ARRAY[
    'security_deposit'::text,
    'pet_deposit'::text,
    'key_deposit'::text,
    'cleaning_deposit'::text,
    'move_in_fee'::text,
    'cleaning_fee'::text,
    'pet_fee'::text,
    'application_fee'::text,
    'amenity_fee'::text,
    'hoa_transfer_fee'::text,
    'lease_prep_fee'::text,
    'pet_rent'::text,
    'parking_rent'::text,
    'storage_rent'::text,
    'amenity_fee_monthly'::text,
    'trash_fee'::text,
    'pest_control_fee'::text,
    'technology_fee'::text,
    'last_month_rent'::text,
    'early_termination_fee'::text,
    'other_fee'::text
  ]));

-- Backfill: idempotent INSERT skips leases that already have a
-- security_deposit lease_fee row (e.g. re-runs of this migration in
-- dev, though migration runner enforces single application via
-- schema_migrations checksum).
INSERT INTO lease_fees (lease_id, fee_type, due_timing, amount, description, created_at, updated_at)
SELECT
  l.id,
  'security_deposit',
  'move_in',
  l.security_deposit,
  'Security deposit (S195 backfill from leases.security_deposit)',
  COALESCE(l.created_at, NOW()),
  NOW()
FROM leases l
WHERE l.security_deposit IS NOT NULL
  AND l.security_deposit > 0
  AND NOT EXISTS (
    SELECT 1 FROM lease_fees lf
    WHERE lf.lease_id = l.id
      AND lf.fee_type = 'security_deposit'
      AND lf.due_timing = 'move_in'
  );
