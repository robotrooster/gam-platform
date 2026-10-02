-- A new lease the tenant has not signed: when the landlord was told.
--
-- Nic (10/2): a sitting tenant's new lease takes over on its start date and
-- bills the new rent "whether or not they sign it". The landlord-signed lease
-- stays open for the tenant's signature, and the landlord is told TWICE that
-- it is still unsigned: 14 days before it starts, and on the day it starts.
-- Each alert goes once per document; these columns are what make it once.
--
--   renewal_unsigned_alert_14d_at   — the "starts in 14 days, not signed yet" alert
--   renewal_unsigned_alert_start_at — the "started today, still not signed" alert
--
-- NULL on every row today (no renewal document exists in production).
--
-- EXPAND ONLY. Nullable, no default, no backfill needed. Safe to drop.

ALTER TABLE lease_documents
  ADD COLUMN IF NOT EXISTS renewal_unsigned_alert_14d_at timestamptz,
  ADD COLUMN IF NOT EXISTS renewal_unsigned_alert_start_at timestamptz;

COMMENT ON COLUMN lease_documents.renewal_unsigned_alert_14d_at IS
  'S655: when the landlord was told, 14 days before a new lease for a sitting tenant starts, that the tenant has not signed it. Once per document.';
COMMENT ON COLUMN lease_documents.renewal_unsigned_alert_start_at IS
  'S655: when the landlord was told, on the day a new lease for a sitting tenant started, that the tenant still has not signed it. Once per document.';
