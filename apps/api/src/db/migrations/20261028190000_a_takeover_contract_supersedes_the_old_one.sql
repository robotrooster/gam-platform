-- 10/28 (Nic) — A TAKEOVER IS A NEW CONTRACT, AND IT SUPERSEDES THE OLD ONE.
--
--   "The takeover is essentially a new contract in all manner. It's a new
--    lease, it's a new contract, it's a new whatever the landlord wants to set.
--    It just supersedes the old one after signature and it's only available on
--    landlord invite. If the landlord wants to keep the same terms, let the
--    person only finish paying what was previously owed. If the landlord wants
--    to do it on a new installment term sale with a different monthly payment
--    on the trailer, that's their choice. We are not forcing them into any sort
--    of situation. We are providing them the capability to operate how they
--    want."
--
-- This replaces the model the 10/23 migration built for (one contract changing
-- hands, terms frozen, `home_sale_assumptions`). That answered a narrower
-- question — the same purchase continuing under a new payer — and it forced the
-- landlord to keep the old terms. The rule is the LEASE's rule: new paper, the
-- landlord's own terms on it, and the signature is what retires what came
-- before.
--
-- So the symmetry is exact:
--     leases.replaces_lease_id                 → the tenancy this lease retires
--     lease_documents.supersedes_home_sale_...  → the purchase this paper retires
-- and in both cases nothing happens until the new resident signs. Before that
-- the old contract keeps billing the person on it, which is the recoverable
-- direction: an unsigned takeover leaves the park exactly where it was.
--
-- The old contract is never edited or deleted — it is closed as 'superseded'
-- with a pointer to what replaced it, so the months somebody actually paid stay
-- attributed to them and the books never re-project a sale under a new name.
--
-- 20261028170000 added `assumes_home_sale_contract_id` for the superseded
-- design earlier today. It is left in place (all NULL, read by nothing) rather
-- than dropped from production over a few minutes' difference; this column is
-- the one the code uses.

ALTER TABLE lease_documents
  ADD COLUMN IF NOT EXISTS supersedes_home_sale_contract_id UUID
    REFERENCES home_sale_contracts(id) ON DELETE SET NULL;

COMMENT ON COLUMN lease_documents.supersedes_home_sale_contract_id IS
  'The home purchase this installment paper retires when it is fully signed. '
  'Set by the landlord on a takeover invite. The new contract is built from '
  'this document''s own typed terms, so the landlord may keep the old payment '
  'or write a new one; the old contract is closed as superseded, never edited.';

ALTER TABLE home_sale_contracts
  ADD COLUMN IF NOT EXISTS superseded_by_contract_id UUID
    REFERENCES home_sale_contracts(id) ON DELETE SET NULL;

COMMENT ON COLUMN home_sale_contracts.superseded_by_contract_id IS
  'The contract that retired this one at a space takeover. Set together with '
  'status = superseded.';

-- 'superseded' is not 'cancelled': a cancelled sale was called off, a
-- superseded one ran its course under one buyer and continues under another.
-- The billing queries key on status = 'active', so either one stops billing.
DO $$
DECLARE def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conrelid = 'public.home_sale_contracts'::regclass
     AND conname = 'home_sale_contracts_status_check';
  IF def IS NULL THEN
    RAISE EXCEPTION 'home_sale_contracts_status_check is gone — add superseded by hand';
  END IF;
  IF position('superseded' IN def) = 0 THEN
    IF position('''cancelled''::text' IN def) = 0 THEN
      RAISE EXCEPTION 'the status CHECK no longer ends at cancelled (%) — add superseded by hand', def;
    END IF;
    ALTER TABLE home_sale_contracts DROP CONSTRAINT home_sale_contracts_status_check;
    ALTER TABLE home_sale_contracts ADD CONSTRAINT home_sale_contracts_status_check
      CHECK (status = ANY (ARRAY['pending_signature'::text, 'active'::text,
                                 'paid_off'::text, 'cancelled'::text, 'superseded'::text]));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_lease_documents_supersedes_home_sale
  ON lease_documents (supersedes_home_sale_contract_id)
  WHERE supersedes_home_sale_contract_id IS NOT NULL;

-- A document retires a purchase only on a unit (the same shape the lease
-- takeover's constraint holds).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.lease_documents'::regclass
       AND conname = 'lease_documents_supersede_needs_unit'
  ) THEN
    ALTER TABLE lease_documents
      ADD CONSTRAINT lease_documents_supersede_needs_unit
      CHECK (supersedes_home_sale_contract_id IS NULL OR unit_id IS NOT NULL);
  END IF;
END $$;
