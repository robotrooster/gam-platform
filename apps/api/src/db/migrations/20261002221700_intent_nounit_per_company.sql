-- S655 (security): a screening waiver belongs to the company that granted it.
--
-- A grandfather / returning-resident waiver is recorded on a no-unit
-- pending_tenant_intents row. The only uniqueness on those rows was
-- pending_tenant_intents_tenant_nounit_live_key, on tenant_id ALONE, and the
-- waive upsert targeted it. So when company X waived somebody who already had
-- a live no-unit row at company Y, the upsert rewrote Y's row: Y's invite
-- vanished from Y's pending list, Y's returning-resident allowance was charged,
-- and the waiver landed on a row Y owns.
--
-- One live no-unit row per person PER COMPANY. The application code now
-- targets this index.
--
-- EXPAND ONLY. The old tenant-only index stays until the new code is deployed
-- (it is stricter, so every existing row already satisfies this one); a later
-- contract migration drops pending_tenant_intents_tenant_nounit_live_key once
-- nothing targets it. Until then a second company's no-unit row is refused by
-- the old index instead of overwriting another company's row.

CREATE UNIQUE INDEX IF NOT EXISTS pending_tenant_intents_tenant_landlord_nounit_live_key
  ON pending_tenant_intents (tenant_id, landlord_id)
  WHERE cancelled_at IS NULL AND unit_id IS NULL;
