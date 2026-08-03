-- S576 (B-8): 'work_trade_addendum' document type.
-- A landlord can include their own work-trade addendum form in a lease's e-sign
-- flow (Nic: "merge the two documents together in the same e-signature flow").
-- It behaves like a standalone signed document — the signed PDF IS the legal
-- instrument, no lease mutation on completion — so it joins the same allow-list
-- branch as the standalone contract types. Both CHECK constraints must list it.
-- No backfill: no existing rows use the new value.

ALTER TABLE lease_documents DROP CONSTRAINT lease_documents_document_type_check;
ALTER TABLE lease_documents ADD CONSTRAINT lease_documents_document_type_check
  CHECK (document_type = ANY (ARRAY[
    'original_lease'::text, 'addendum_add'::text, 'addendum_remove'::text,
    'addendum_terms'::text, 'sublease_agreement'::text, 'purchase_agreement'::text,
    'bill_of_sale'::text, 'general_contract'::text, 'work_trade_addendum'::text]));

ALTER TABLE lease_documents DROP CONSTRAINT lease_documents_addendum_fields_check;
ALTER TABLE lease_documents ADD CONSTRAINT lease_documents_addendum_fields_check
  CHECK (
    ((document_type = 'addendum_remove'::text) AND (target_lease_tenant_id IS NOT NULL))
    OR
    ((document_type = ANY (ARRAY[
        'original_lease'::text, 'addendum_add'::text, 'addendum_terms'::text,
        'sublease_agreement'::text, 'purchase_agreement'::text, 'bill_of_sale'::text,
        'general_contract'::text, 'work_trade_addendum'::text]))
      AND (target_lease_tenant_id IS NULL) AND (promote_lease_tenant_id IS NULL)));
