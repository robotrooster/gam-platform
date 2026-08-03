-- S576 Snowbird Phase 1: lease hibernation (seasonal pause).
-- A seasonal/snowbird lease can be flipped dormant for the off-season instead
-- of terminated: no rent invoices generate, no platform fee accrues, the deposit
-- stays held, the tenancy record persists, and the ACH bank mandate is left
-- untouched (rent is invoice-driven, so no invoice = no pull — the snowbird is
-- never wrongly charged off-season). Resume flips it back and billing restarts.
-- See ~/gam/SNOWBIRD_SEASONAL_SPEC.md.
--
-- Modeled as a FLAG on an otherwise-active lease (not a new status) so the lease
-- stays a real active tenancy everywhere EXCEPT the billing consumers that
-- explicitly gate on it (invoiceGeneration + platformFeeAccrual). Minimal blast
-- radius. No backfill needed — every existing lease is not hibernating.
ALTER TABLE leases
  ADD COLUMN is_hibernating boolean NOT NULL DEFAULT false,
  ADD COLUMN hibernated_at  timestamptz;

CREATE INDEX idx_leases_hibernating ON leases (is_hibernating) WHERE is_hibernating = true;
