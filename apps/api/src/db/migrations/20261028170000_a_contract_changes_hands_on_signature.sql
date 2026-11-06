-- 10/28 (Nic) — THE BUYER SIGNS, AND THAT IS WHAT MAKES THEM THE BUYER.
--
--   "When somebody's taking over and making the payments, they become the new
--    owner. So they need to sign that as well. The original buyer is not on the
--    contract at that point. They are replacing the person on the contract. Why
--    would a person make the payments if they're not on the contract?"
--
-- The space takeover already works this way: a replacement lease carries
-- `leases.replaces_lease_id`, and the REPLACEMENT'S signature is what ends the
-- sitting tenancy (services/spotSuccession). The home being bought on that
-- space had no equivalent, so the only paper the new buyer signed was the
-- lease — they were billed for a trailer they had never signed for.
--
-- This is the same route for the contract. A document says which contract it
-- assumes; the new buyer's signature on it is what hands the payments over
-- (home_sale_assumptions), the same way their signature on the lease hands over
-- the space. No signature, no handover: the person still on the contract keeps
-- being billed, which is the recoverable direction.
--
-- WHY A COLUMN ON THE DOCUMENT rather than a new document_type. The paper IS
-- the landlord's own installment-sale contract (lease_templates.purpose =
-- 'installment_sale') — they bring their own forms, and an assumption is that
-- same form signed by the person taking it over, with the remaining balance and
-- payments as its terms. What makes it an assumption is not a different kind of
-- document, it is that it names a contract already in flight. Mirrors
-- replaces_lease_id exactly.
--
-- No backfill: every existing document assumes nothing, which is today's
-- behaviour (a signed installment-sale document creates a new contract).

ALTER TABLE lease_documents
  ADD COLUMN IF NOT EXISTS assumes_home_sale_contract_id UUID
    REFERENCES home_sale_contracts(id) ON DELETE SET NULL;

COMMENT ON COLUMN lease_documents.assumes_home_sale_contract_id IS
  'The home-sale contract this document hands over, set when the landlord '
  'confirms the new buyer is taking over an existing purchase. Their signature '
  'records the handover (home_sale_assumptions); it never creates a second '
  'contract and never edits the first one''s terms.';

-- Finding the assumption document for a contract, and refusing a second one.
CREATE INDEX IF NOT EXISTS idx_lease_documents_assumes_home_sale
  ON lease_documents (assumes_home_sale_contract_id)
  WHERE assumes_home_sale_contract_id IS NOT NULL;

-- A document hands over ONE contract and only a contract on its own unit. The
-- unit check cannot be a CHECK constraint (it reads another table), so it is
-- enforced where the document is created; this is the part a constraint can
-- hold: a document that assumes a contract is about a unit.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.lease_documents'::regclass
       AND conname = 'lease_documents_assumption_needs_unit'
  ) THEN
    ALTER TABLE lease_documents
      ADD CONSTRAINT lease_documents_assumption_needs_unit
      CHECK (assumes_home_sale_contract_id IS NULL OR unit_id IS NOT NULL);
  END IF;
END $$;
