-- Property-level fee schedule + lease-fee override flagging.
--
-- Anti-discrimination model (S154): fees should apply uniformly
-- across leases on a property. Landlord defines a "Standard Fee
-- Schedule" per property; new leases pre-populate from that
-- schedule. Per-lease deviations are still allowed (legitimate
-- cases: documented damage at move-in justifying a higher cleaning
-- fee, grandfathered terms, etc.) but flagged with is_override +
-- override_reason so the audit trail captures the rationale.
--
-- Source-of-truth: the LEASE remains the legal contract. The
-- property schedule is the policy that pre-populates new lease
-- documents. Once the tenant signs, the lease_fees rows are frozen
-- and don't track changes to the property schedule.
--
-- Schema notes:
--   property_fee_schedules:
--     - One row per (property_id, fee_type, slot_index).
--     - slot_index is 0 for all single-instance fee types (cleaning,
--       pet_deposit, etc.); for other_fee, slot_index 0,1,2,... lets
--       a property define multiple variants (e.g. "Pet cleaning" +
--       "Move-in inspection" + "Pool key fee").
--     - description matters most for other_fee — landlord names the
--       variant. For named fee types (cleaning_fee, etc.) it's
--       optional / informational.
--     - amount, is_refundable, due_timing — same shape as lease_fees.
--
--   lease_fees additions:
--     - is_override: TRUE when the landlord deviated from the
--       property's standard at lease creation. Pre-existing rows
--       default to FALSE (correct: they predate the schedule).
--     - override_reason: free-form text. Required at the UI layer
--       when is_override=TRUE; not enforced at DB level so legacy
--       data stays valid.
--
-- No backfill needed.

CREATE TABLE property_fee_schedules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  fee_type        TEXT NOT NULL CHECK (fee_type = ANY (ARRAY[
    'pet_deposit', 'key_deposit', 'cleaning_deposit',
    'move_in_fee', 'cleaning_fee', 'pet_fee', 'application_fee',
    'amenity_fee', 'hoa_transfer_fee', 'lease_prep_fee',
    'pet_rent', 'parking_rent', 'storage_rent', 'amenity_fee_monthly',
    'trash_fee', 'pest_control_fee', 'technology_fee',
    'last_month_rent', 'early_termination_fee', 'other_fee'
  ])),
  slot_index      INTEGER NOT NULL DEFAULT 0 CHECK (slot_index >= 0),
  description     TEXT,
  amount          NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  is_refundable   BOOLEAN NOT NULL,
  due_timing      TEXT NOT NULL CHECK (due_timing IN ('move_in', 'monthly_ongoing', 'move_out', 'other')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (property_id, fee_type, slot_index)
);

CREATE INDEX idx_property_fee_schedules_property ON property_fee_schedules (property_id);

ALTER TABLE lease_fees
  ADD COLUMN is_override BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN override_reason TEXT;
