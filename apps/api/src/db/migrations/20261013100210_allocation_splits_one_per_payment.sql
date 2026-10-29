-- 10/12 (Nic) — ONE OWNER-SHARE SPLIT PER PAYMENT, ENFORCED
--
-- allocation_splits (20261013100200) stores how executeRentAllocation split
-- the money GAM held on one settled row. Everything that reads it — the
-- ledger projector, the backfill's "already done" check — takes one row per
-- payment, but nothing held it to one: the backfill's guard was a NOT EXISTS
-- read with no lock, so two overlapping runs (the deploy's and a hand run; the
-- backfill is meant to run twice) could each write a split, and so could a
-- payment allocated again after its owner share was removed by hand. The
-- table refuses DELETE (append-only), so the second row could never be taken
-- back, and a ledger projecting splits would count that payment twice.
--
-- A plain unique index (not a constraint), so the writers can say
-- ON CONFLICT (payment_id) DO NOTHING: services/allocation.recordAllocationSplit
-- and scripts/oct12_ledger_source_facts_backfill.ts both do, so neither can
-- fail a settle or write twice. The first split on record stands.
--
-- Expand-only. No backfill needed: production has no allocation_splits rows
-- yet (the table ships with this release), and this runs before the backfill.
-- Safe drop: DROP INDEX allocation_splits_one_per_payment.

CREATE UNIQUE INDEX IF NOT EXISTS allocation_splits_one_per_payment ON allocation_splits (payment_id);

COMMENT ON INDEX allocation_splits_one_per_payment IS
  '10/12 (Nic, ledger P1 review): one split per payment; writers insert ON CONFLICT (payment_id) DO NOTHING.';
