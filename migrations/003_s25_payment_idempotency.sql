-- Session 25: payment row idempotency for rent + recurring fee generation.
-- Adds lease_fee_id linkage + partial unique indexes so daily cron can safely re-run.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS lease_fee_id UUID REFERENCES lease_fees(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payments_lease_fee_id ON payments(lease_fee_id);

-- One rent row per lease per due_date, excluding failed/returned rows
-- (pending/processing/settled all block duplicates; failed/returned allow a legitimate retry row).
CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_rent_idempotent
  ON payments(lease_id, due_date)
  WHERE type = 'rent' AND status IN ('pending','processing','settled');

-- One fee row per lease_fee per due_date, same status filter.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_fee_idempotent
  ON payments(lease_fee_id, due_date)
  WHERE type = 'fee' AND status IN ('pending','processing','settled');
