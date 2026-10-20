-- 10/20 — A DELIVERED PROPANE FILL CAN NAME A STAY OR A SERVICED AGREEMENT,
-- NOT ONLY A LEASE.
--
-- Nic, on where delivered propane is about to be:
--
--   "At another property that's yet to be onboarded, that will also happen at RV
--    sites. So it needs to not be unit type exclusive."
--
-- propane_fills.lease_id was NOT NULL, and services/propaneFill validateFillLine
-- refuses a fill on any space without an ACTIVE LEASE. On a mobile home park
-- that is invisible — every occupied space has a lease. On RV sites it is the
-- common case: Andres Razo was on RV 27 at Mountain View for 31 nights on
-- stay_terms 'stay' with no lease at all, and a serviced agreement
-- (utility_service_agreements, built 10/05) is the other way a space is occupied
-- by somebody who owes for what they used without signing a lease.
--
-- So a truck filling a tank on an occupied RV site could not be written down at
-- all. The table has 0 rows, so nothing is broken today — and that is exactly
-- why it gets fixed today. It is the shape of a defect that shows up on the new
-- property's FIRST DAY, with a truck already gone and gallons nobody can bill.
--
-- WHAT THIS DOES: lets a fill name whichever of the three occupancies was there,
-- and requires that it name ONE of them. A fill that names nobody is gallons
-- charged to no one, which is the opposite of every dollar being counted once.
-- tenant_id relaxes with it, because a stay guest is not necessarily a tenant —
-- unit_bookings.tenant_id is itself nullable and a guest may be nothing but a
-- name and an email.
--
-- WHAT THIS DOES NOT DO: it does not decide how a stay guest's propane gets
-- billed. A lease bills through payments rows on the monthly invoice; a stay has
-- a balance and a serviced agreement has its own due day and late-fee policy.
-- Which of those a delivery lands on is Nic's call and a new money mechanism, so
-- the write path (services/propaneFill) still bills the lease case only. This
-- migration removes the schema wall so that answer can be wired without a
-- migration standing between the truck and the ledger.
--
-- EXPAND ONLY. Dropping NOT NULL accepts strictly more than before. The two new
-- columns are nullable with no default. The CHECK is satisfied by every existing
-- row (there are none) and by every row the current code writes (it always sets
-- lease_id). Re-runnable.

ALTER TABLE propane_fills ALTER COLUMN lease_id  DROP NOT NULL;
ALTER TABLE propane_fills ALTER COLUMN tenant_id DROP NOT NULL;

ALTER TABLE propane_fills
  ADD COLUMN IF NOT EXISTS service_agreement_id uuid REFERENCES utility_service_agreements(id),
  ADD COLUMN IF NOT EXISTS booking_id           uuid REFERENCES unit_bookings(id);

COMMENT ON COLUMN propane_fills.lease_id IS
  '10/20: the lease that was on the space, when there was one. Nullable since '
  'delivered propane reaches RV sites held by a stay or a serviced agreement.';
COMMENT ON COLUMN propane_fills.service_agreement_id IS
  '10/20: the utility service agreement that was on the space — the occupant who '
  'owes for what they used without signing a lease.';
COMMENT ON COLUMN propane_fills.booking_id IS
  '10/20: the stay that was on the space. A stay guest may have no tenant row at '
  'all, which is why tenant_id is nullable beside this.';

-- One of the three, always. Gallons that name no occupancy are gallons nobody
-- owes for.
ALTER TABLE propane_fills DROP CONSTRAINT IF EXISTS propane_fills_names_an_occupancy;
ALTER TABLE propane_fills ADD CONSTRAINT propane_fills_names_an_occupancy
  CHECK (lease_id IS NOT NULL OR service_agreement_id IS NOT NULL OR booking_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_propane_fills_service_agreement
  ON propane_fills (service_agreement_id) WHERE service_agreement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_propane_fills_booking
  ON propane_fills (booking_id) WHERE booking_id IS NOT NULL;
