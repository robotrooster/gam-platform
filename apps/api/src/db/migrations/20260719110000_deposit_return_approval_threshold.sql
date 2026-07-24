-- S548: deposit-return approval threshold (Nic).
--
-- Front desk can initiate deposit returns (the leases.deposit_return
-- permission key), but money leaving to a tenant above this amount
-- needs the landlord's eyes. Mirrors maint_approval_threshold: refunds
-- at/below the threshold finalize by staff alone; above it the return
-- parks awaiting_approval and the landlord finalizes. Default $500,
-- landlord-set in Settings (0 = always require approval).
--
-- No backfill needed (DEFAULT covers existing rows).

ALTER TABLE landlords
  ADD COLUMN deposit_return_approval_threshold numeric(10,2) NOT NULL DEFAULT 500;
