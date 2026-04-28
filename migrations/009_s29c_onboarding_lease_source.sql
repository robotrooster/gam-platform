-- Migration 009: existing-tenant onboarding + imported lease tracking
-- S29c — adds onboarding_source to tenants, lease_source + imported_pdf_url to leases.

BEGIN;

-- A. tenants.onboarding_source
ALTER TABLE tenants
  ADD COLUMN onboarding_source TEXT NOT NULL DEFAULT 'applied';

ALTER TABLE tenants
  ADD CONSTRAINT tenants_onboarding_source_check
  CHECK (onboarding_source = ANY (ARRAY['applied'::text, 'onboarded'::text]));

-- All existing tenants are 'applied' by default. Going forward, the onboarding
-- flow stamps 'onboarded' explicitly. No backfill changes for existing rows —
-- they all came in via application.

-- B. leases.lease_source
ALTER TABLE leases
  ADD COLUMN lease_source TEXT NOT NULL DEFAULT 'esigned';

ALTER TABLE leases
  ADD CONSTRAINT leases_lease_source_check
  CHECK (lease_source = ANY (ARRAY['esigned'::text, 'imported'::text]));

-- Existing leases default to 'esigned' (they all came through the e-sign pipeline).
-- Imported leases set 'imported' on insert.

-- C. leases.imported_pdf_url
ALTER TABLE leases
  ADD COLUMN imported_pdf_url TEXT;

-- Nullable. Set when landlord drops the original paper lease PDF on the unit
-- post-onboarding. Parser session consumes from this column.

COMMIT;
