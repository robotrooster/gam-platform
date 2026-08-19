-- S604 (Nic): 'owner_use' unit status — the owner (or their manager) occupies
-- the unit themselves.
--
-- WHY: an owner living in one of their own units had no honest way to say so.
-- Marking it 'vacant' listed it for rent and understated occupancy; marking it
-- 'active' implied a lease and a rent roll that do not exist.
--
-- Semantics: no lease, no rent, not bookable, not listed — but NOT vacant, so
-- it counts as occupied. The $2/occupied-unit platform fee is waived
-- STRUCTURALLY rather than by exception: platformFeeAccrual bills distinct
-- units with an ACTIVE LEASE, and an owner_use unit has none. That is also the
-- anti-cheat — a unit with no lease cannot collect rent through GAM either, so
-- the status cannot be used to hide a paying tenant from billing.
--
-- Mirrors UNIT_STATUSES in packages/shared/src/index.ts (single source of truth
-- for enums per CLAUDE.md).
--
-- No backfill needed: purely additive to the CHECK; no existing row changes.

ALTER TABLE units DROP CONSTRAINT IF EXISTS units_status_check;
ALTER TABLE units
  ADD CONSTRAINT units_status_check
  CHECK (status = ANY (ARRAY[
    'vacant'::text,
    'available'::text,
    'active'::text,
    'delinquent'::text,
    'suspended'::text,
    'owner_use'::text
  ]));

-- status_before_block stores the status to restore when eviction mode is turned
-- off. It is only ever written from a real status, so it takes the same set.
COMMENT ON COLUMN units.status IS
  'vacant | available | active | delinquent | suspended | owner_use. S604: owner_use = owner-occupied — no lease, no rent, not bookable, counts as occupied, never billed the per-unit platform fee.';

-- "No lease" is the DEFINING property of owner_use, and leases are created from
-- five different paths (landlords.ts ×2, esign.ts, bookingLeaseDraft,
-- applicationLeaseDraft). Guarding each call site would leave the rule one new
-- path away from being false, so it is enforced once here. The reverse
-- direction (flipping a leased unit to owner_use) is guarded in
-- PATCH /api/units/:id/status.
CREATE OR REPLACE FUNCTION reject_lease_on_owner_use_unit() RETURNS trigger AS $$
DECLARE
  unit_status text;
BEGIN
  IF NEW.status NOT IN ('active', 'pending') THEN
    RETURN NEW;
  END IF;
  SELECT u.status INTO unit_status FROM units u WHERE u.id = NEW.unit_id;
  IF unit_status = 'owner_use' THEN
    RAISE EXCEPTION 'Unit % is marked owner-occupied and cannot hold a lease. Change its status first.', NEW.unit_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reject_lease_on_owner_use_unit ON leases;
CREATE TRIGGER trg_reject_lease_on_owner_use_unit
  BEFORE INSERT OR UPDATE OF unit_id, status ON leases
  FOR EACH ROW EXECUTE FUNCTION reject_lease_on_owner_use_unit();
