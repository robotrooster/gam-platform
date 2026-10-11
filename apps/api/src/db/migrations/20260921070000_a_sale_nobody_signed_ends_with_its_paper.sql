-- S652 — A SALE NOBODY SIGNED IS CANCELLED WHEN ITS PAPER IS VOIDED.
--
-- Found clearing Lot 1 at Country Acres for a redraft. Voiding an unsigned
-- installment agreement flipped the document and nothing else: its
-- home_sale_contracts row stayed at 'pending_signature' forever. Only one live
-- contract is allowed per unit (home_sale_contracts_one_live_per_unit), so the
-- orphan silently blocked ever drafting a sale on that unit again. The void
-- looked like it worked; the unit was stuck.
--
-- A TRIGGER, not a fourth hand-copied line. Documents are voided from four
-- places — the void button, the 48-hour signing timeout, the renewal auto-void,
-- and re-drafting a lease to add a person — and each carried its own partial
-- copy of the steps. The timeout had the same hole as the button. Same reasoning
-- as retire-and-replace (S605): a rule about a table is enforced at the table,
-- so a fifth void path written next year is covered without anybody remembering.
--
-- Only 'pending_signature'. An active contract means somebody signed for it, and
-- a document a tenant has signed cannot be voided in the first place.
--
-- No backfill needed: checked production, zero contracts were stranded this way.

CREATE OR REPLACE FUNCTION cancel_unsigned_sale_on_void() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'voided' AND OLD.status IS DISTINCT FROM 'voided' THEN
    UPDATE home_sale_contracts
       SET status = 'cancelled', updated_at = now()
     WHERE purchase_document_id = NEW.id
       AND status = 'pending_signature';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cancel_unsigned_sale_on_void
  AFTER UPDATE OF status ON lease_documents
  FOR EACH ROW
  EXECUTE FUNCTION cancel_unsigned_sale_on_void();
