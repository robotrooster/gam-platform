-- S614 (Nic, LAUNCH-CRITICAL): billing utilities across the property line.
--
--   "We need to fix the billing for utilities next door immediately, because we
--    already collect from those units next door. That is an Oak Park launch
--    necessity. That's seventy-five dollars in trash cans and utilities on one
--    electric submeter from next door."
--
-- Oak Park's trash and power feed spaces that are not Oak Park's units and never
-- will be — different owner, no lease, no tenancy. Money is already changing
-- hands off-platform for them.
--
-- THE MODEL (Nic): "It is technically a unit." The space is a real unit at Oak
-- Park so it can carry meter assignments, a trash-can count and a share of a
-- RUBS pool like any other. What it does NOT have is a lease — so a SERVICE
-- AGREEMENT names who pays. Nic: "That person should really have access to the
-- tenant portal to get on and pay their bill. Otherwise the landlord has to
-- bother to take cash from the other property."
--
-- THE FEE (Nic, corrected me twice — get this right): $2 is per OCCUPIED UNIT,
-- never per person and never per billing relationship. Two people in one unit is
-- $2, not $4. A unit is occupied by the utility-billing landlord BECAUSE OF the
-- utilities; when the space's real owner later onboards and puts a lease on it,
-- it becomes physically occupied under them — a SUPERSEDENCE. The $2 moves and
-- is never charged twice. There is no mid-month conflict because the incoming
-- landlord sits inside the no-double-bill grace until their second cycle, and
-- that cycle belongs wholly to them.
--
-- WHY NOT A LEASE ROW WITH ZERO RENT: a lease is a legal instrument here — it
-- drives eviction, e-sign, occupancy, rent, deposits and "the lease is law". A
-- fake one for a non-tenant would leak into all of it. This carries only what is
-- true: someone owes this landlord for utilities at this address.

-- The space itself is a unit, marked so nothing treats it as rentable.
ALTER TABLE units DROP CONSTRAINT IF EXISTS units_status_check;
ALTER TABLE units ADD CONSTRAINT units_status_check
  CHECK (status = ANY (ARRAY['vacant','active','delinquent','suspended','owner_use','utility_service']));

COMMENT ON COLUMN units.status IS
  'S614: adds ''utility_service'' — a space this landlord bills utilities for but '
  'does not own or lease (next door, cross-property). Never rentable, never '
  'listed, never bookable; it exists to hold meter assignments and a payer.';

CREATE TABLE IF NOT EXISTS utility_service_agreements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id       uuid NOT NULL REFERENCES landlords(id),
  unit_id           uuid NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  -- The payer. A real tenants row + users row, so they get the tenant portal and
  -- pay their own bill rather than the landlord chasing cash across the fence.
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  -- What this is, in the landlord's words, for the invoice and his own records.
  service_address   text,
  note              text,
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','ended')),
  start_date        date NOT NULL DEFAULT CURRENT_DATE,
  end_date          date,
  -- S614: set when the space's real owner onboards it and a LEASE supersedes
  -- this agreement for platform-fee purposes. The agreement itself stays active
  -- — Oak Park still bills the electric — but the $2 follows the lease.
  superseded_by_lease_id uuid REFERENCES leases(id),
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One live agreement per unit: two payers for one meter feed is a billing
-- ambiguity, not a configuration.
CREATE UNIQUE INDEX IF NOT EXISTS ux_utility_service_agreement_live
  ON utility_service_agreements (unit_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_utility_service_agreements_landlord
  ON utility_service_agreements (landlord_id, status);
CREATE INDEX IF NOT EXISTS idx_utility_service_agreements_tenant
  ON utility_service_agreements (tenant_id);

CREATE TRIGGER audit_utility_service_agreements
  AFTER DELETE OR UPDATE ON utility_service_agreements
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
