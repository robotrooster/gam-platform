-- S652 (Nic): at a park of tenant-owned homes the landlord repairs the park, not
-- the stove. Each property may limit the kinds of maintenance request a
-- tenant can file (NULL = every kind) and say why on the form.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS maintenance_categories TEXT[];
ALTER TABLE properties ADD COLUMN IF NOT EXISTS maintenance_note TEXT;
-- S652 (Nic, option 2): why a background check was waived on an invite —
-- 'grandfather' (sitting resident during the onboarding window) or
-- 'returning_resident' (landlord attests prior tenancy; capped per property).
ALTER TABLE pending_tenant_intents ADD COLUMN IF NOT EXISTS waive_reason TEXT;
