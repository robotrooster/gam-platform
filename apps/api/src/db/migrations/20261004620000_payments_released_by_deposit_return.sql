-- 10/4 (decisions #46.3, Step 9 review fix pass 3): A DEPOSIT PAYMENT GAM
-- COLLECTED KEEPS READING AS GAM'S AFTER A MOVE-OUT RELEASES IT.
--
-- Who holds a deposit payment is decided by how it was collected
-- (leaseFeesSync.depositCollectedBySql): paid electronically through GAM
-- (platform_held) → GAM; paid at the desk or into the landlord's bank → the
-- landlord. A finalized move-out clears platform_held on every GAM-held
-- deposit payment it used up — the security deposit's GAM part and any pet,
-- key or cleaning deposit GAM held — because from then on its money rides the
-- held payout item or the refund GAM owes (counted on their own lines in GAM's
-- balance book), never as a deposit GAM still holds.
--
-- After that, the reader could only tell "GAM collected it" by looking at the
-- security deposit RECORD (held_by 'gam_escrow'). On a lease whose security
-- deposit the landlord holds (paid at the desk) and whose pet deposit was paid
-- online through GAM, the pet payment read 'landlord' after finalize, though
-- GAM collected it. Any later reader (a carried lease chain's settled deposit
-- payments) would misread who holds it.
--
-- → released_by_deposit_return_id: set by finalize on each deposit payment it
--   releases (the same UPDATE that clears platform_held). A payment carrying it
--   was collected by GAM; depositCollectedBySql reads it, on the payment
--   itself.
--
-- Expand-only: one nullable column. No backfill needed — no move-out has
-- released a deposit payment this way in production (the release ships with
-- this deploy). Safe drop: the column (the reader falls back to the record's
-- holder). No foreign key: deposit_returns rows are never deleted, and the
-- column is a record of what happened, read only as "is it set".

ALTER TABLE payments ADD COLUMN IF NOT EXISTS released_by_deposit_return_id uuid;

COMMENT ON COLUMN payments.released_by_deposit_return_id IS
  '10/4 (decisions #46.3): the finalized move-out (deposit_returns.id) that released this GAM-collected deposit payment — it cleared platform_held because the money now rides a held payout item or the refund GAM owes. Set only on payments GAM collected, so leaseFeesSync.depositCollectedBySql reads such a payment as collected by GAM before and after the move-out. NULL: never released by a move-out.';
