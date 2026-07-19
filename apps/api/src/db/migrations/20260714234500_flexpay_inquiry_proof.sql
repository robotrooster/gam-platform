-- S542b: FlexPay proof-of-income upload (Nic).
--
-- WHY: imported/onboarded tenants never pass through the new-tenant
-- flow, so the platform has NO income data for them — and FlexPay is
-- hard-gated to PROVEN SSI/SSDI. Nothing is landlord-facing: the
-- tenant shows proof (SSA award letter / benefit verification letter)
-- directly TO THE PLATFORM from the tenant portal, attached to their
-- FlexPay inquiry. Admin reviews the document in the FlexPay Requests
-- queue before approving (the approval attestation is now backed by
-- an in-system document instead of off-platform collection).
--
-- Single active document per inquiry (re-upload replaces; old file
-- unlinked best-effort). Served ONLY via authed routes (S535 rule):
-- the tenant's own GET + the admin queue's GET. Never the landlord.
--
-- No backfill needed.

ALTER TABLE flexpay_inquiries
  ADD COLUMN proof_file_path     text,
  ADD COLUMN proof_original_name text,
  ADD COLUMN proof_uploaded_at   timestamptz;
