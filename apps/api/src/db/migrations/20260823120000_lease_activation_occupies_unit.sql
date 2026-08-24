-- A unit with a started, active lease is OCCUPIED. Enforced here, not at call sites.
--
-- S619. ONBOARDING_PUNCHLIST.md states the shipped rule plainly: units are
-- created "always vacant; leases flip it." Three paths that create an ALREADY
-- ACTIVE lease never flipped it:
--
--   routes/landlords.ts:1575   onboard a tenant onto an existing lease
--   routes/landlords.ts:3726   bulk CSV lease import
--   jobs/leaseParser/resolveIntent.ts:283   parsed lease document
--
-- routes/landlords.ts contains no UPDATE of units at all. These are exactly the
-- "I already have tenants, import them" paths — the Oak Park path.
--
-- The e-sign flow was never affected: it creates a PENDING lease and flips the
-- unit on signature. Booking and application drafts are pending too, and the
-- 2am activatePendingLeases job flips those when the start date arrives.
--
-- What it cost, with two live examples found in the demo portfolio on
-- 2026-08-23 — RV 01 (Henry Park, lease from 2026-08-01) and House 01
-- (Nic Test, from 2026-08-10), both holding an active lease and an active
-- tenant while the unit still read 'vacant':
--
--   * the agent tells a landlord a unit is empty while someone lives in it
--     (get_vacant_units reads units.status and nothing else)
--   * the occupancy KPI and the rent roll are wrong the same way
--   * monthlyFeeAccrual counts units.status='active', so GAM never bills the
--     $2 for that unit — the fee is silently skipped, not deferred
--
-- Enforced as a trigger rather than three UPDATEs, for the same reason the
-- retire/replace rules are: a call-site fix is only correct until the next
-- call site is written.

BEGIN;

CREATE OR REPLACE FUNCTION public.occupy_unit_on_active_lease()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only a lease that is active AND has actually started occupies a unit. A
  -- future-dated one has not begun; the nightly reconcile picks it up on the
  -- day it does.
  IF NEW.status <> 'active' OR NEW.start_date IS NULL OR NEW.start_date > CURRENT_DATE THEN
    RETURN NEW;
  END IF;

  -- Only ever promotes an EMPTY unit. 'delinquent' and 'suspended' are already
  -- occupied and carry meaning a lease write must not erase; 'owner_use' and
  -- 'utility_service' cannot hold a lease at all (reject_lease_on_unavailable_unit
  -- blocks owner_use before this runs), and 'retired' units likewise.
  UPDATE units
     SET status = 'active', updated_at = NOW()
   WHERE id = NEW.unit_id
     AND status IN ('vacant', 'available')
     AND retired_at IS NULL;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_occupy_unit_on_active_lease ON public.leases;
CREATE TRIGGER trg_occupy_unit_on_active_lease
  AFTER INSERT OR UPDATE OF status, start_date ON public.leases
  FOR EACH ROW EXECUTE FUNCTION public.occupy_unit_on_active_lease();

-- Backfill the units this already got wrong: a started, active lease sitting on
-- a unit that still reads empty.
UPDATE units u
   SET status = 'active', updated_at = NOW()
 WHERE u.status IN ('vacant', 'available')
   AND u.retired_at IS NULL
   AND EXISTS (
     SELECT 1 FROM leases l
      WHERE l.unit_id = u.id
        AND l.status = 'active'
        AND l.start_date IS NOT NULL
        AND l.start_date <= CURRENT_DATE
   );

COMMIT;
