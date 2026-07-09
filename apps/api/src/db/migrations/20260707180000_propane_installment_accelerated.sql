-- Mark accelerated propane installments (Nic, S533).
--
-- When a new fill lands while a prior fill still has scheduled
-- installments, those installments accelerate to due-now standalone
-- payments. Accelerated balances take PRIORITY over rent (a tenant
-- cannot pay a rent row while an accelerated propane row is unpaid)
-- but sit BEHIND outstanding GAM balances — GAM-first is already
-- structural (supersedence skims any payment at settle). The flag
-- exists so the rent-pay gate can tell accelerated rows apart from
-- ordinary scheduled/invoiced propane installments, which carry no
-- rent priority.
--
-- No backfill needed: acceleration shipped today; no accelerated rows
-- predate the column.

ALTER TABLE propane_fill_installments
    ADD COLUMN accelerated boolean NOT NULL DEFAULT false;
