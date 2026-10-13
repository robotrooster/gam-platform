-- 10/12 (Nic) — "WORKS, TENANT USES NO POWER", NEXT TO "REPAIRED"
--
--   M1: "ADD 'Works, tenant uses no power' choice next to 'Repaired' (Gerald
--        specifically is gone, not plugged in, paying for occupancy)."
--
-- A meter flagged broken because it read the same number twice on an occupied
-- space (S648) now has two ways back into service on the Utilities page:
--   Repaired                        — fixed or replaced; a fresh starting read
--                                     (unchanged, services/meterRepair).
--   Works, tenant uses no power     — the meter was never broken; the household
--                                     on it uses nothing. Records the
--                                     zero-use confirmation
--                                     (utility_meters.zero_use_confirmed_at,
--                                     20261013110000) so a flat read bills $0
--                                     and is not flagged or estimated again.
-- 10/12 (Nic): "Works, tenant uses no power" may be chosen on ANY meter, any
-- time — flagged or not. When it is chosen on a flagged meter, voiding the
-- unpaid estimates billed while it was flagged is the landlord's choice at that
-- moment (services/meterRepair voidFlaggedPeriodEstimates; no schema needed —
-- a voided line and its reading keep the void stamps they already have).
--
-- 1. WHO CONFIRMED IT. The "Repaired" choice writes a reading that carries who
--    took it; this choice writes no reading (the meter's readings were right
--    all along), so the confirmation carries its own author. Kept beside the
--    timestamp and cleared with it — when a billed cycle shows use (the
--    monthly run, services/utilityBilling clearZeroUseConfirmation), by
--    marking the meter broken by hand, and by an automatic broken-meter flag
--    (that fires only once the confirmation no longer stands: the household
--    left or a new one arrived). The change journal (audit_utility_meters)
--    keeps every earlier value.
--
-- 2. 10/12 (review): NO TRIGGER ON A READ BEING SAVED. The first draft of this
--    migration cleared the confirmation the moment any read differing from
--    the one before it was saved (trg_meter_read_clears_zero_use), and nothing
--    put it back when that read was corrected — the reading's own edit, the
--    walk's same-cycle correction and resolve-review all correct reads before
--    billing, and a small typo (49093 for 49083) is never held for review. The
--    confirmation was lost, and the next flat cycle flagged the meter and, at
--    Mountain View, billed the very estimate M1 was built to stop. Whether the
--    meter moved is decided from the reads AS THEY STAND when the cycle is
--    billed (the monthly run clears it when the cycle's usage is above 0), so
--    a corrected read is simply the read. The draft was never applied to a
--    live database; the DROPs below only clean a test database that ran it.
--
-- Expand-only, safe before the code ships: a nullable column nothing reads
-- until the code does.
-- Safe drop: ALTER TABLE utility_meters DROP COLUMN zero_use_confirmed_by_user_id;

ALTER TABLE utility_meters
  ADD COLUMN IF NOT EXISTS zero_use_confirmed_by_user_id uuid REFERENCES users(id);

COMMENT ON COLUMN utility_meters.zero_use_confirmed_by_user_id IS
  '10/12 (Nic): who chose "Works, tenant uses no power" (or confirmed it with a repair). Set and cleared together with zero_use_confirmed_at.';

DROP TRIGGER IF EXISTS trg_meter_read_clears_zero_use ON utility_meter_readings;
DROP FUNCTION IF EXISTS clear_zero_use_confirmation_when_meter_moves();
