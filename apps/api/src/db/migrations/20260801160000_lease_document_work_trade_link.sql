-- S576 (B-8): link a signed lease-addendum document back to its work-trade
-- agreement. When a landlord sends a work-trade addendum (a normal lease
-- addendum on the tenant's ACTIVE lease — the agreement already requires one),
-- we stamp the agreement id so the system KNOWS that document is the work-trade
-- addendum (Nic: no name-guessing — the send action declares it). Powers the
-- "addendum on file" surface on the agreement + dedupes the renewal auto-carry.
-- Nullable: only work-trade addendum documents carry it. ON DELETE SET NULL so
-- deleting an agreement never orphans a signed document.
ALTER TABLE lease_documents
  ADD COLUMN work_trade_agreement_id uuid
  REFERENCES work_trade_agreements(id) ON DELETE SET NULL;

CREATE INDEX idx_lease_documents_work_trade_agreement
  ON lease_documents (work_trade_agreement_id)
  WHERE work_trade_agreement_id IS NOT NULL;
