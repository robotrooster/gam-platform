-- S577 — retroactive late fees: late_fee_accrual_from (Nic).
--
-- Controls where the daily/period late-fee accrual starts COUNTING once grace
-- is crossed. Grace still gates WHETHER any fee applies; this only moves the
-- counting anchor. Landlord-configurable, neutral copy ("check your local
-- laws") — NOT state-specific logic, nothing labeled by state.
--   grace_end         : accrual starts after the grace period (prior behavior)
--   due_date          : retroactive, one tick per day AFTER the due date
--   due_date_inclusive: retroactive, counting includes the due date itself
--
-- DEFAULTS (Nic): the values that happen to fit the first cohort (all AZ) are
-- the defaults, without labeling anything Arizona:
--   • POLICY (property_unit_type_late_fees) DEFAULT 'due_date_inclusive' — a new
--     late-fee decision / newly-drafted lease is retroactive-inclusive out of
--     the box; the landlord can change it and the UI carries a check-your-laws note.
--   • LEASE (leases) DEFAULT 'grace_end' — existing SIGNED leases NEVER change
--     (lease-is-law; a tenant never agreed to a retroactive fee mid-lease). A new
--     lease gets the policy value STAMPED at draft time, same as the other
--     late-fee terms.
--
-- Enum mirrors shared LATE_FEE_ACCRUAL_FROMS. No backfill concern: policy rows
-- take the retroactive default (pre-launch, first cohort is AZ); lease rows take
-- grace_end so nothing already signed shifts.

ALTER TABLE property_unit_type_late_fees
  ADD COLUMN late_fee_accrual_from text NOT NULL DEFAULT 'due_date_inclusive'
    CHECK (late_fee_accrual_from = ANY (ARRAY['grace_end','due_date','due_date_inclusive']::text[]));

ALTER TABLE leases
  ADD COLUMN late_fee_accrual_from text NOT NULL DEFAULT 'grace_end'
    CHECK (late_fee_accrual_from = ANY (ARRAY['grace_end','due_date','due_date_inclusive']::text[]));
