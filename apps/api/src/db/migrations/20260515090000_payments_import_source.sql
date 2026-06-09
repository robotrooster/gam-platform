-- Phase B (S29X): rent-roll payment history import.
--
-- When a landlord migrates from a prior PM software (Buildium / AppFolio /
-- DoorLoop / etc.) and uploads a transaction-history CSV, each historical
-- payment lands as a `payments` row with status='settled'. The two
-- columns below mark the row as imported so admin reports + the tenant
-- account history can distinguish migration data from native GAM
-- payments.
--
-- No backfill needed — pre-Phase-B rows stay NULL on both columns
-- (= native GAM payment). The Phase-B commit endpoint sets both
-- atomically when writing the import.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS import_source text NULL,
  ADD COLUMN IF NOT EXISTS imported_at timestamptz NULL;

COMMENT ON COLUMN payments.import_source IS
  'Phase B: which prior platform brought this payment in via CSV import (buildium / appfolio / doorloop / yardi / rentmanager / propertyware / rentec / tenantcloud / generic). NULL = native GAM payment.';

COMMENT ON COLUMN payments.imported_at IS
  'Phase B: timestamp the import commit ran. Distinct from settled_at (which carries the historical payment date from the source CSV).';

-- Partial index — only rows that were imported. Keeps the index small
-- and lets the admin "show migration data" filter run cheaply.
CREATE INDEX IF NOT EXISTS idx_payments_import_source
  ON payments (import_source)
  WHERE import_source IS NOT NULL;
