-- S546 (Nic): automated verification — take the manual process out.
--
-- The platform already knows the lease (drafted it or parsed it), so
-- verification is machine work:
--   - Proof PDFs are text-extracted on upload (lib/pdfText stack);
--     the document must contain a lease holder's name and is scanned
--     for SSA/SSI/SSDI language. No match / not machine-readable →
--     SILENT hold (S545c mechanism). Match → data points recorded and
--     approval needs no human confirmations at all.
--   - auto_verification jsonb: { nameMatch: 'matched'|'no_match'|
--     'unreadable'|'manual_ok', matchedName, benefitKeywords: bool,
--     checkedAt }. 'manual_ok' is the exception path: releasing a
--     hold records the human resolution — no checkbox ritual in the
--     normal flow.
--
-- PRE-QUALIFICATION (backend-only, NEVER tenant-visible): a nightly
-- sweep computes each tenant's FlexPay readiness from structured data
-- (ssi_ssdi flag, ACH, active lease, DOB on file) BEFORE any interest
-- is expressed — so when interest arrives the file is already warm.
-- tenants.flexpay_prequal jsonb: { status: 'prequalified'|'not',
-- reasons: [...], computedAt }.
--
-- No backfill needed (sweep + upload hooks populate).

ALTER TABLE flexpay_inquiries
  ADD COLUMN auto_verification jsonb;

ALTER TABLE tenants
  ADD COLUMN flexpay_prequal jsonb;
