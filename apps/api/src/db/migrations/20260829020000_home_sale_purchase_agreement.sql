-- S629 (Nic): "we need to be able to have a separate purchase contract sent
-- through the esignature flow that's separate from the lease, but still read
-- for the monthly billing."
--
-- Today a home-sale contract is created by hand and starts billing immediately.
-- The purchase agreement, if one is sent at all, is an unrelated document — so
-- the terms a tenant signed and the terms GAM bills are two independent facts
-- that nothing reconciles. For a financed sale running years, that is the gap
-- that matters.
--
-- purchase_document_id ties the billing to the signed paper, and
-- 'pending_signature' lets the contract exist BEFORE it is binding: terms
-- agreed, schedule not generated, nothing billed. Signature is what turns it
-- into money, which is the same rule leases already follow — the signed
-- document is the authority.

ALTER TABLE home_sale_contracts
  ADD COLUMN IF NOT EXISTS purchase_document_id uuid REFERENCES lease_documents(id);

ALTER TABLE home_sale_contracts DROP CONSTRAINT IF EXISTS home_sale_contracts_status_check;
ALTER TABLE home_sale_contracts ADD CONSTRAINT home_sale_contracts_status_check
  CHECK (status = ANY (ARRAY['pending_signature'::text, 'active'::text, 'paid_off'::text, 'cancelled'::text]));

-- One live contract per unit, where "live" now includes one awaiting signature.
-- Without this a landlord could send two purchase agreements for the same home
-- and have whichever signed second silently start a second billing stream.
CREATE UNIQUE INDEX IF NOT EXISTS home_sale_contracts_one_live_per_unit
  ON home_sale_contracts (unit_id)
  WHERE status IN ('pending_signature', 'active');

CREATE INDEX IF NOT EXISTS home_sale_contracts_purchase_document
  ON home_sale_contracts (purchase_document_id)
  WHERE purchase_document_id IS NOT NULL;

COMMENT ON COLUMN home_sale_contracts.purchase_document_id IS
  'S629: the signed purchase agreement this billing comes from. Set when the contract is drafted for signature; the contract stays pending_signature (no installments, nothing billed) until that document completes.';
