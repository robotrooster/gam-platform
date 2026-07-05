-- W-27 (final walkthrough, S531, Nic): migration protection. Permanent
-- tenants awaiting onboard (limbo-state pending pool) occupy a real spot —
-- a guest must not be able to book it while the landlord finishes
-- digitizing their lease. The intent optionally binds that unit; the ONE
-- availability predicate (services/unitAvailability.ts) treats units with
-- an OPEN intent (resolved_at IS NULL) as not free. The block lifts
-- naturally when the intent resolves into a lease or is removed.
-- NULL = no unit bound (pre-existing rows and tenants without a spot yet).
-- No backfill needed.

ALTER TABLE pending_tenant_intents
  ADD COLUMN unit_id uuid REFERENCES units(id) ON DELETE SET NULL;

CREATE INDEX idx_pending_tenant_intents_unit_open
  ON pending_tenant_intents (unit_id) WHERE resolved_at IS NULL;
