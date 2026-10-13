-- 10/12 (Nic) — A VOIDED SALE KEEPS WHEN IT WAS VOIDED
--
-- Voiding a register sale (routes/pos POST /transactions/:id/void) sets its
-- status to 'voided' and keeps the reason — but not the moment. The ledger
-- reverses a voided sale's postings on the day it was voided, so the day has to
-- be on the sale (gam-ledger-design-2026-10-12 §P1, M2).
--
-- voided_at is written by the void itself, in the same UPDATE that marks it.
--
-- Backfill needed: sales voided before today — the restock the void wrote
-- (pos_inventory_log 'Sale voided') gives the moment when there is one, else
-- the sale's own time (scripts/oct12_ledger_source_facts_backfill.ts, named in
-- ledger_derived_facts). Production 10/12: 0 voided sales.
-- Safe drop: ALTER TABLE pos_transactions DROP COLUMN voided_at.

ALTER TABLE pos_transactions ADD COLUMN IF NOT EXISTS voided_at timestamptz;

COMMENT ON COLUMN pos_transactions.voided_at IS
  '10/12 (Nic, ledger P1): when the sale was voided (status voided). Written by the void.';
