-- 10/2 (Nic): "I already have a tenant profile. So if I click my name as a
-- customer, it should automatically fill it in in all matching card
-- transactions."
--
-- One register record per person per company. A resident who buys at the
-- register gets a register record that points at their tenant row, so the
-- cards they tap and the sales they make hang on the same record a walk-in's
-- would — and linking one card sale to them can carry every other sale on that
-- card. Their name and email are read from their account; the record holds no
-- copy anyone edits.
--
-- Expand-only: a nullable column and a partial unique index. Code that does not
-- know about the column keeps working; nothing is backfilled (a resident's
-- record is made the first time a sale is linked to them).
ALTER TABLE pos_customers ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);

-- One live record per resident per company. Archived (merged-away) records
-- keep their tenant_id as history and do not count.
CREATE UNIQUE INDEX IF NOT EXISTS pos_customers_landlord_tenant_uniq
  ON pos_customers (landlord_id, tenant_id)
  WHERE archived_at IS NULL AND tenant_id IS NOT NULL;
