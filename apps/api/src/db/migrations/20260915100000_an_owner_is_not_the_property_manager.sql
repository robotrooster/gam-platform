-- S644 — THE OWNER LAYER.
--
-- A property manager with 11,000 units across Texas, Oklahoma and Georgia does
-- not own them. Other people do, and those people get reports and get paid.
-- Until now GAM modelled "the landlord" and "the PM company" and had nothing
-- that said which owners a PM works for — the connection existed only property
-- by property, through properties.pm_company_id.
--
-- Two things are true about an owner and not about a property, which is why
-- this is its own table rather than more columns on `properties`:
--
--   1. HOW THEY GET PAID. Nic (S644, DIRECTIVE): per-owner choice. Some owners
--      take their share the moment a tenant's rent settles; others want the PM
--      to collect everything and cut them one cheque a month, which is how most
--      licensed managers in those three states actually operate. An owner with
--      six parks does not want that answered six different ways.
--
--   2. WHETHER THEY CAN LOG IN. Nic (S644, DIRECTIVE): "Owner can access if
--      they want. Request portal access through PM, but PM can't deny an owner."
--      Note what is NOT in this table: there is no `denied` state and no column
--      recording a refusal, because refusing is not an available act. The PM is
--      the CHANNEL for the request, not a gate on it. See the status CHECK.
--
-- One row per (manager, owner). A landlord who manages their own property has
-- no row here at all — this table describes a relationship, and there isn't one.
CREATE TABLE IF NOT EXISTS pm_owner_relationships (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  pm_company_id      uuid NOT NULL REFERENCES pm_companies(id) ON DELETE CASCADE,
  landlord_id        uuid NOT NULL REFERENCES landlords(id)    ON DELETE CASCADE,

  -- 'direct'   — the owner's share leaves at settlement for the owner's own
  --              bank, which is what allocation.ts already does today.
  -- 'pm_trust' — the owner's share is held to the manager's account and paid
  --              out on a disbursement run. GAM is then holding money that
  --              belongs to a third party, which is why it is tracked to the
  --              cent in its own ledger rather than inferred from payments.
  payout_mode        text NOT NULL DEFAULT 'direct'
                       CHECK (payout_mode IN ('direct','pm_trust')),

  -- How often a 'pm_trust' owner is paid. Ignored for 'direct'.
  disbursement_day   smallint NOT NULL DEFAULT 10
                       CHECK (disbursement_day BETWEEN 1 AND 28),

  -- 'none'    — nobody has asked.
  -- 'active'  — the owner can sign in and see their own properties.
  -- 'closed'  — the OWNER stepped away from it. Only the owner closes this.
  --
  -- There is deliberately no 'denied' and no 'pending'. A request that can only
  -- ever be granted is not a decision, and leaving it pending would let a
  -- manager deny by silence — which is the same refusal with better manners.
  portal_access      text NOT NULL DEFAULT 'none'
                       CHECK (portal_access IN ('none','active','closed')),
  portal_opened_at   timestamptz,
  portal_opened_by   text CHECK (portal_opened_by IN ('owner','pm_company','gam')),
  portal_closed_at   timestamptz,

  status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','ended')),
  ended_at           timestamptz,

  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pm_company_id, landlord_id)
);

CREATE INDEX IF NOT EXISTS idx_pm_owner_rel_company
  ON pm_owner_relationships (pm_company_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_pm_owner_rel_landlord
  ON pm_owner_relationships (landlord_id) WHERE status = 'active';
-- The disbursement run reads this every day: only trust owners, only live ones.
CREATE INDEX IF NOT EXISTS idx_pm_owner_rel_trust_day
  ON pm_owner_relationships (disbursement_day)
  WHERE payout_mode = 'pm_trust' AND status = 'active';

-- Backfill from what the properties already say. Every (manager, owner) pair
-- that exists in the wild becomes a relationship on the DEFAULT terms: paid
-- directly, no portal. That is exactly how those properties behave today, so
-- nothing changes for anybody until someone chooses otherwise.
INSERT INTO pm_owner_relationships (pm_company_id, landlord_id)
SELECT DISTINCT p.pm_company_id, p.landlord_id
  FROM properties p
 WHERE p.pm_company_id IS NOT NULL
   AND p.landlord_id IS NOT NULL
ON CONFLICT (pm_company_id, landlord_id) DO NOTHING;

-- Keep it true without asking ~120 call sites to remember. A property that
-- joins a manager creates the relationship on default terms; nothing is ever
-- deleted here (a relationship that ends is marked, not removed), so a park
-- that leaves and comes back finds its own terms waiting.
CREATE OR REPLACE FUNCTION ensure_pm_owner_relationship() RETURNS trigger AS $$
BEGIN
  IF NEW.pm_company_id IS NOT NULL AND NEW.landlord_id IS NOT NULL THEN
    INSERT INTO pm_owner_relationships (pm_company_id, landlord_id)
    VALUES (NEW.pm_company_id, NEW.landlord_id)
    ON CONFLICT (pm_company_id, landlord_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ensure_pm_owner_relationship ON properties;
CREATE TRIGGER trg_ensure_pm_owner_relationship
  AFTER INSERT OR UPDATE OF pm_company_id, landlord_id ON properties
  FOR EACH ROW EXECUTE FUNCTION ensure_pm_owner_relationship();
