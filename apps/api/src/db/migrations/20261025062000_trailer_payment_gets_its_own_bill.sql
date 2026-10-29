-- 10/25 (Nic): A TRAILER PAYMENT IS ITS OWN BILL.
--
--   "Should trailer payments get their own invoice separately payable from lot
--    rent? Yeah, let's do that, and they need to be clearly labeled — I've had
--    some people literally try to say, oh, I paid my rent, and then it's like,
--    no, that was the trailer payment, you have the space rent too."
--
-- WHY a bill of its own, and not a line on the rent bill:
--   * Lisa Scheeler is on work trade, so she never gets a rent bill. Her
--     trailer payment had nowhere to land.
--   * Dominic Gonzalez's space rent is the park's money and his trailer payment
--     is the trust's. One bill cannot be paid into two books.
--   * Rent is pay-in-full platform-wide, so a trailer payment sharing the rent
--     bill could not be paid on its own — and both of the above need it to be.
--
-- Same shape as invoices.service_agreement_id (S615): a bill that belongs to
-- something other than a lease, paid by itself.
--
-- invoices already carried the invariant EVERY BILL HAS EXACTLY ONE OWNER
-- (invoices_payer_source_check: lease_id XOR service_agreement_id, with a
-- voided bill the one exception). That invariant is right, so this third owner
-- JOINS the list rather than being carved out of it.
--
-- No backfill, and no money moves: every home payment billed so far is a line
-- on a rent bill and stays exactly where it is. Only bills written from here on
-- get their own document.
--
-- Expand-only and re-runnable (posPropaneProduct.test.ts asserts every recent
-- migration applies twice cleanly), which is also why it supersedes the two
-- files 20261025060000 + 20261025061500: those did the same work without the
-- guards. They had already applied, so they were replaced rather than edited —
-- their schema_migrations rows stay as the record that they ran, and this file
-- is a no-op on any database they already touched.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS home_sale_contract_id uuid REFERENCES home_sale_contracts(id) ON DELETE SET NULL;

COMMENT ON COLUMN invoices.home_sale_contract_id IS
  'The installment (home/trailer) sale this bill is for. Set => the bill is that
   contract''s own document, paid by itself, and carries no space rent. NULL on
   every lease bill and every utility-service bill.';

-- One bill per contract per cycle. The partial predicate has to be repeated at
-- every ON CONFLICT that infers this index, or Postgres raises 42P10.
CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_home_sale_contract_cycle
  ON invoices (home_sale_contract_id, due_date)
  WHERE home_sale_contract_id IS NOT NULL;

-- Exactly one owner, now of three. Dropped first so this is re-runnable, and
-- so it replaces whichever earlier form of the rule is in place.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_one_non_lease_owner;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_payer_source_check;

ALTER TABLE invoices
  ADD CONSTRAINT invoices_payer_source_check CHECK (
    (  (lease_id IS NOT NULL)::int
     + (service_agreement_id IS NOT NULL)::int
     + (home_sale_contract_id IS NOT NULL)::int) = 1
    OR (status = 'void'
        AND lease_id IS NULL
        AND service_agreement_id IS NULL
        AND home_sale_contract_id IS NULL
        AND voided_from_lease_id IS NOT NULL)
  );
