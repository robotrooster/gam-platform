-- 10/13 — LOOKUPS FOR "WHAT STILL POINTS AT THIS DOCUMENT"
--
-- Nic (10/13): "If it never completed, it doesn't exist." A document that never
-- completed and that no money touched is now erased instead of voided
-- (lib/eraseUnfinishedDocument). Deciding that asks, per document, whether a
-- person joined or left a lease through it, whether an open invite is waiting
-- on it, whether it started a sublease or recorded a home's owner — and the
-- GoldSign list asks it for every open document on the page, to label the
-- row's button Delete or Void. Erasing the row also makes Postgres check each
-- of these foreign keys.
--
-- None of these columns had an index, so every one of those questions read the
-- whole table: per document on the list, per row erased. Partial indexes on the
-- rows that name a document (most do not). No behavior changes. Expand-only,
-- no backfill needed; production has at most a few hundred rows in each, so the builds
-- are instant. Idempotent.

CREATE INDEX IF NOT EXISTS idx_lease_tenants_add_document ON lease_tenants (add_document_id)
  WHERE add_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lease_tenants_remove_document ON lease_tenants (remove_document_id)
  WHERE remove_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pending_tenant_intents_draft_document ON pending_tenant_intents (draft_document_id)
  WHERE draft_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subleases_document ON subleases (sublease_document_id)
  WHERE sublease_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_home_ownerships_sale_document ON home_ownerships (sale_document_id)
  WHERE sale_document_id IS NOT NULL;
