-- S615: when a real tenancy lands on a serviced space, the $2 moves.
--
-- S614 added superseded_by_lease_id and nothing ever SET it. Nic's model:
--
--   "A unit is occupied by the utility-billing landlord BECAUSE OF the
--    utilities. When the space's real owner onboards and puts a lease on it, it
--    becomes physically occupied under them — a SUPERSEDENCE event. The $2 moves
--    and is never charged twice for one space."
--
-- Enforced as a TRIGGER rather than at the call sites that create or activate a
-- lease. There are many of those — onboarding, the invite accept, the CSV
-- import, the booking draft, the lease lifecycle job — and a rule about what is
-- true of a UNIT should not depend on which door the lease came through. Any
-- door that is added later inherits it for free.
--
-- WHAT IS DELIBERATELY NOT CHANGED: the agreement stays ACTIVE and keeps
-- billing. Oak Park is still supplying that power; the meter still turns and
-- somebody still owes for it. Only the PLATFORM FEE follows the lease. Ending
-- the service is a separate decision for the landlord to make out loud, not
-- something a lease elsewhere decides for him.

CREATE OR REPLACE FUNCTION supersede_utility_service_agreement()
RETURNS TRIGGER AS $$
BEGIN
  -- Only a LIVE tenancy supersedes. A draft or a signed-but-not-started lease
  -- has not put anybody in the space yet, and stamping on those would move the
  -- fee for a tenancy that may never begin.
  IF NEW.status = 'active' THEN
    UPDATE utility_service_agreements sa
       SET superseded_by_lease_id = NEW.id,
           updated_at = NOW()
     WHERE sa.unit_id = NEW.unit_id
       AND sa.status = 'active'
       AND sa.superseded_by_lease_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_supersede_utility_service_agreement ON leases;
CREATE TRIGGER trg_supersede_utility_service_agreement
  AFTER INSERT OR UPDATE OF status ON leases
  FOR EACH ROW EXECUTE FUNCTION supersede_utility_service_agreement();

COMMENT ON FUNCTION supersede_utility_service_agreement() IS
  'S615: a lease going active on a serviced space stamps the agreement so the '
  '$2 platform fee follows the tenancy and is never charged twice for one '
  'space. The agreement keeps billing utilities — only the fee moves.';

-- Backfill: any space that already carries both. None exist at Oak Park today
-- (no leases at all), but a landlord importing history could produce one, and a
-- rule that only applies going forward is a rule with a hole in it.
UPDATE utility_service_agreements sa
   SET superseded_by_lease_id = l.id, updated_at = NOW()
  FROM leases l
 WHERE l.unit_id = sa.unit_id
   AND l.status = 'active'
   AND sa.status = 'active'
   AND sa.superseded_by_lease_id IS NULL;
