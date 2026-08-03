-- Generic (standalone) e-sign document types (S568, Nic — full generic e-sign).
--
-- WHY: the e-sign engine (lease_documents + signers + fields + templates) is
-- generic under the hood, but document_type was locked to lease/addendum/sublease
-- types. Add standalone types so the SAME engine can run purchase agreements
-- (financed home sales), resident-to-resident sales (landlord not a party), and
-- business quotes/bids — with arbitrary signer roles + no lease/unit binding.
-- lease_id / unit_id are already nullable; only these CHECKs needed widening.
--
-- Two CHECKs gate document_type:
--   * lease_documents_document_type_check — the allowed set.
--   * lease_documents_addendum_fields_check — ties addendum_remove to a target
--     tenant, and everything else to target/promote = NULL. Standalone docs have
--     no lease tenants, so they join the "target IS NULL AND promote IS NULL" arm.
-- Single source of truth: shared LEASE_DOCUMENT_TYPES (now includes the 3 below).
-- Safe: widening allowed values; no backfill.

ALTER TABLE lease_documents DROP CONSTRAINT IF EXISTS lease_documents_document_type_check;
ALTER TABLE lease_documents ADD CONSTRAINT lease_documents_document_type_check
  CHECK (document_type IN (
    'original_lease','addendum_add','addendum_remove','addendum_terms','sublease_agreement',
    'purchase_agreement','bill_of_sale','general_contract'));

ALTER TABLE lease_documents DROP CONSTRAINT IF EXISTS lease_documents_addendum_fields_check;
ALTER TABLE lease_documents ADD CONSTRAINT lease_documents_addendum_fields_check
  CHECK (
    (document_type = 'addendum_remove' AND target_lease_tenant_id IS NOT NULL)
    OR (document_type IN (
          'original_lease','addendum_add','addendum_terms','sublease_agreement',
          'purchase_agreement','bill_of_sale','general_contract')
        AND target_lease_tenant_id IS NULL AND promote_lease_tenant_id IS NULL)
  );
