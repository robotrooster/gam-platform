-- 10/12 (Nic) — AN UNDONE RECEIPT KEEPS WHEN, AND BY WHOM
--
-- "Undo match" on a tenant's bank deposit (bankDepositConfirm.undoDepositMatch)
-- takes the deposit back off the bills it paid and closes its receipt: the
-- tenant_remittances row goes from 'settled' to 'failed' with a note. Nothing
-- on the receipt said WHEN that happened or WHO did it — the status was simply
-- overwritten (the bank line's own undo marker is replaced the next time it is
-- matched). The ledger has to post the receipt's money coming back out on the
-- day it was undone (gam-ledger-design-2026-10-12 §P1, M2).
--
-- undone_at / undone_by are written by the undo itself, in the same UPDATE that
-- closes the receipt. A receipt that never settled and failed (a declined card,
-- a returned ACH before settle) is not undone: both stay NULL.
--
-- Backfill needed: receipts that settled and were closed by an undo before
-- today — the bank line's undo marker gives the time and the person when it is
-- still there, else the receipt's updated_at (scripts/
-- oct12_ledger_source_facts_backfill.ts, named in ledger_derived_facts).
-- Production 10/12: 0 such receipts.
-- Safe drop: ALTER TABLE tenant_remittances DROP COLUMN undone_at, DROP COLUMN undone_by.

ALTER TABLE tenant_remittances
  ADD COLUMN IF NOT EXISTS undone_at timestamptz,
  ADD COLUMN IF NOT EXISTS undone_by uuid REFERENCES users(id);

COMMENT ON COLUMN tenant_remittances.undone_at IS
  '10/12 (Nic, ledger P1): when a settled receipt was taken back off the bills it paid (bank-deposit Undo match). NULL: never undone.';
COMMENT ON COLUMN tenant_remittances.undone_by IS
  '10/12 (Nic, ledger P1): who pressed Undo match (NULL when undone by the system or before 10/12 with no record).';
