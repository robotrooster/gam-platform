-- Tenant complaints — the record the AGENT CHAT creates.
--
-- S618 (Nic): "the table is gonna be created in the agent chat. That's the
-- point of contact where tenants are gonna complain about the neighbor, or
-- they're gonna do it as a maintenance request — hey, tell my neighbor to turn
-- their shit down."
--
-- Asked which tenants complain about their neighbours most, the honest answer
-- today is that nothing anywhere records it: there is no complaints table and
-- no dispute log. The chat is where a tenant actually says it out loud, so the
-- chat is where it gets written down. Once it is a row, the landlord can ask
-- the two questions that matter and get real answers:
--
--   who complains the most            -> a tenant who may be needy
--   who is complained ABOUT the most  -> the neighbour who is the actual problem
--
-- NOT a maintenance request. maintenance_requests.category is a closed list
-- (hvac, plumbing, electrical, appliance, landscape, pest, cleaning, roofing,
-- structural, pool, locksmith) with nothing that fits a neighbour, and stuffing
-- one in would corrupt repair reporting and repair cost per unit.
--
-- Values mirror COMPLAINT_CATEGORY_VALUES / COMPLAINT_STATUS_VALUES in
-- packages/shared/src/index.ts — one definition, per the enum rule.
--
-- No backfill needed: nothing has been recorded until now.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_complaints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who raised it, and the tenancy it came from.
  tenant_id     uuid NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  lease_id      uuid          REFERENCES leases(id)    ON DELETE SET NULL,
  unit_id       uuid          REFERENCES units(id)     ON DELETE SET NULL,
  property_id   uuid          REFERENCES properties(id) ON DELETE SET NULL,
  -- Denormalised so every landlord-scoped query filters on one indexed column,
  -- the same way payments and maintenance_requests do.
  landlord_id   uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,

  category      text NOT NULL CHECK (category = ANY (ARRAY[
                  'noise','neighbor','parking','pets','smell','trash',
                  'property_condition','harassment','safety','other'])),

  -- WHO or WHAT it is about. Both nullable on purpose: "tell my neighbor to
  -- turn their shit down" names nobody, and demanding a unit before recording
  -- it would mean recording nothing. about_unit_id is set only when the tenant
  -- actually identifies the unit.
  about_unit_id uuid REFERENCES units(id) ON DELETE SET NULL,
  about_text    text,

  -- What they said, in their words. The landlord reads this, not a summary.
  body          text NOT NULL,

  status        text NOT NULL DEFAULT 'open' CHECK (status = ANY (ARRAY[
                  'open','reviewed','resolved','dismissed'])),

  -- Where it came from. 'agent_chat' is the path this table exists for;
  -- 'portal' is reserved for a form if one is ever added.
  source        text NOT NULL DEFAULT 'agent_chat'
                  CHECK (source = ANY (ARRAY['agent_chat','portal','staff'])),
  -- The conversation it was raised in, so the landlord can see the context.
  conversation_id text,

  resolved_at   timestamptz,
  resolution_note text,
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  updated_at    timestamptz NOT NULL DEFAULT NOW()
);

-- "Who complains most" and "who is complained about most" are the two reads
-- this table exists to serve; both are landlord-scoped.
CREATE INDEX IF NOT EXISTS idx_tenant_complaints_landlord ON tenant_complaints(landlord_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_complaints_tenant   ON tenant_complaints(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_complaints_about    ON tenant_complaints(about_unit_id) WHERE about_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenant_complaints_open     ON tenant_complaints(landlord_id) WHERE status = 'open';

DROP TRIGGER IF EXISTS trg_tenant_complaints_updated_at ON tenant_complaints;
CREATE TRIGGER trg_tenant_complaints_updated_at
  BEFORE UPDATE ON tenant_complaints
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMIT;
