-- W-7 (final walkthrough, S531): renewal decision workflow. A renewal is
-- drafted as a normal original_lease e-sign document for the SAME unit and
-- tenants with the new terms prefilled; this column links the draft to the
-- lease it renews so completion can do renewal-specific handling:
--   • copy the predecessor's deposit-category lease_fees onto the new
--     lease AFTER move-in invoice generation (deposit carries forward,
--     never re-billed — returnable at final move-out), and
--   • let the lease-end processor hand the unit off to the successor
--     instead of vacating it.
-- NULL = not a renewal (every pre-existing document). No backfill needed.

ALTER TABLE lease_documents
  ADD COLUMN renews_lease_id uuid REFERENCES leases(id) ON DELETE SET NULL;
