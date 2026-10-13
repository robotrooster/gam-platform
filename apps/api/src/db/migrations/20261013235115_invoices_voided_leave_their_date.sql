-- 10/12 (Nic, G7) — KEEP EVERYTHING: A BILL A SHORTENED STAY EMPTIED IS
-- VOIDED, NOT DELETED, AND GIVES ITS DATE BACK.
--
-- When a stay's dates move its end earlier, rent past the new end is voided
-- (services/bookingLeaseBilling). A bill left with nothing live on it was then
-- DELETED, for one reason: a lease has one bill per due date
-- (ux_invoices_lease_due_date, the slot every bill run inserts against with
-- ON CONFLICT (lease_id, due_date)), so a void bill left on the lease would
-- keep the date and the bill run could never bill that month again if the
-- stay grew back. The bill, and what it said, went with it.
--
-- Now the bill is kept: status 'void', total $0, the reason in its notes, its
-- voided lines still on it — and it lets go of the lease's date the only way a
-- non-partial unique index allows (it cannot become partial: four live
-- statements infer it by its columns, see 20260821230000): its lease moves to
--   voided_from_lease_id — the lease the bill was written on
-- and lease_id becomes NULL (a unique index treats NULLs as distinct, so the
-- slot is free again, exactly as the delete left it). Every per-lease reader
-- sees what it saw after the delete; the bill and its lines stay on record.
--
-- invoices_payer_source_check (a bill has a lease or a utility agreement, one
-- of them) gains that one case: a VOID bill with neither, that names the lease
-- it was voided from.
--
-- Expand-only: a nullable column and a CHECK that only gets wider; nothing
-- writes a lease-less void bill before the code ships. No backfill (the bills
-- deleted before this are gone; the change journal has them).

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS voided_from_lease_id uuid REFERENCES leases(id);

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_payer_source_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_payer_source_check
  CHECK (((lease_id IS NOT NULL) <> (service_agreement_id IS NOT NULL))
         OR (status = 'void' AND lease_id IS NULL AND service_agreement_id IS NULL
             AND voided_from_lease_id IS NOT NULL));

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_voided_from_lease_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_voided_from_lease_check
  CHECK (voided_from_lease_id IS NULL OR (status = 'void' AND lease_id IS NULL));

CREATE INDEX IF NOT EXISTS idx_invoices_voided_from_lease
  ON invoices (voided_from_lease_id) WHERE voided_from_lease_id IS NOT NULL;

COMMENT ON COLUMN invoices.voided_from_lease_id IS
  '10/12 (G7): the lease a void bill was written on, when the void gave the lease''s due date back (lease_id is then NULL): a bill a shortened stay emptied. Kept forever.';
