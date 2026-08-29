-- S629 (Nic): "I've got a couple of people that have two spots, two separate
-- leases. I need them to not be two separate tenant portal accounts. I need it
-- to be two leases linked to that same tenant portal account. Very important
-- that it doesn't screw that up."
--
-- The portal-account half was already right: the invite reuses an existing user
-- and an existing tenant row, so one person stays one login no matter how many
-- units they take.
--
-- The invite half was not. pending_tenant_intents_tenant_id_live_key was UNIQUE
-- on tenant_id alone, so a person could hold only ONE live invite, and the
-- route's ON CONFLICT (tenant_id) DO UPDATE SET unit_id = EXCLUDED.unit_id
-- MOVED the existing invite to the new unit. Inviting somebody to their second
-- spot silently cancelled their first: they would end up with one lease instead
-- of two, with nothing to show an invite had been lost.
--
-- Uniqueness belongs on the pair. Two indexes rather than one, because unit_id
-- is nullable and Postgres treats NULLs as distinct — a single (tenant_id,
-- unit_id) index would let a tenant accumulate unlimited unit-less invites,
-- which is the case the original constraint existed to stop.

DROP INDEX IF EXISTS pending_tenant_intents_tenant_id_live_key;

-- One live invite per person PER UNIT. Two spots, two invites, one login.
CREATE UNIQUE INDEX IF NOT EXISTS pending_tenant_intents_tenant_unit_live_key
  ON pending_tenant_intents (tenant_id, unit_id)
  WHERE cancelled_at IS NULL AND unit_id IS NOT NULL;

-- The parser flow invites without a unit; there is still only ever one of those.
CREATE UNIQUE INDEX IF NOT EXISTS pending_tenant_intents_tenant_nounit_live_key
  ON pending_tenant_intents (tenant_id)
  WHERE cancelled_at IS NULL AND unit_id IS NULL;
