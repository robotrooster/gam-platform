-- S655 money plan M5 (Step 1). Expand-only: one added column, default off.
--
-- Nic (10/2): autopay gets a tenant setting "use my account credit first",
-- off by default. Off: autopay charges the whole bill and the credit waits for
-- the tenant to choose. On: it uses all usable credit and charges the rest.
ALTER TABLE tenant_autopay ADD COLUMN IF NOT EXISTS use_credit boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN tenant_autopay.use_credit IS
  'S655 (Nic): "use my account credit first". Off by default: autopay charges the whole bill and the credit waits for the tenant. Tenant-only, like the rest of this table.';
