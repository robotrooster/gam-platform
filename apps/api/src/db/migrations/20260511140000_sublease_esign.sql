-- S251: Sublease e-sign integration.
--
-- Adds the 'awaiting_signatures' status to subleases (between
-- 'pending' and 'active') so an approved sublease lives in a
-- documents-pending state until both parties have signed. Extends
-- the lease_documents.document_type enum to include
-- 'sublease_agreement' — the existing esign infrastructure handles
-- the signer flow, completion dispatch, and PDF rendering; this
-- migration just opens the door for sublease-shaped documents.
-- Per-property landlord-uploaded template URL overrides the GAM
-- default template at document generation time.
--
-- ── Schema additions ─────────────────────────────────────────────
-- 1. subleases.status CHECK adds 'awaiting_signatures'
-- 2. properties.sublease_agreement_template_url (text, nullable)
-- 3. lease_documents.document_type CHECK adds 'sublease_agreement'
-- 4. lease_documents.addendum_fields_check updated so 'sublease_
--    agreement' requires both target_lease_tenant_id + promote_lease_
--    tenant_id to be NULL (consistent with original_lease branch)
-- 5. subleases.sublease_document_id FK to lease_documents — single
--    document per sublease; UPDATE when generated; CASCADE protect
--    via ON DELETE SET NULL (if the document is voided/deleted, the
--    sublease stays but loses its link, ops can manually fix)

-- 1. subleases.status enum
ALTER TABLE subleases DROP CONSTRAINT IF EXISTS subleases_status_check;
ALTER TABLE subleases
  ADD CONSTRAINT subleases_status_check
    CHECK (status = ANY (ARRAY['pending_invite', 'pending', 'awaiting_signatures', 'active', 'terminated']));

-- 2. properties.sublease_agreement_template_url — optional landlord-
--    owned template URL that overrides the GAM default. Stored as
--    text; consumer fetches the content at document generation time.
ALTER TABLE properties
  ADD COLUMN sublease_agreement_template_url text;

-- 3 + 4. lease_documents enum + addendum_fields constraint update.
ALTER TABLE lease_documents
  DROP CONSTRAINT IF EXISTS lease_documents_document_type_check;
ALTER TABLE lease_documents
  ADD CONSTRAINT lease_documents_document_type_check
    CHECK (document_type = ANY (ARRAY[
      'original_lease',
      'addendum_add',
      'addendum_remove',
      'addendum_terms',
      'sublease_agreement'
    ]));

ALTER TABLE lease_documents
  DROP CONSTRAINT IF EXISTS lease_documents_addendum_fields_check;
ALTER TABLE lease_documents
  ADD CONSTRAINT lease_documents_addendum_fields_check
    CHECK (
      ((document_type = 'addendum_remove') AND (target_lease_tenant_id IS NOT NULL))
      OR
      ((document_type = ANY (ARRAY['original_lease','addendum_add','addendum_terms','sublease_agreement']))
        AND (target_lease_tenant_id IS NULL)
        AND (promote_lease_tenant_id IS NULL))
    );

-- 5. subleases.sublease_document_id — link to the signed document.
--    Filled at generation time; signature flow updates the row's
--    status via existing esign infra; sublease activation pulls
--    the document URL into subleases.sublease_document_url on
--    completion (see services/subleaseDocuments.ts execute path).
ALTER TABLE subleases
  ADD COLUMN sublease_document_id uuid REFERENCES lease_documents(id);
