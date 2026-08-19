-- S605 (Nic): opening meter reads — make the baseline a first-class thing.
--
-- A submeter bills on the DIFFERENCE between two reads, so its first cycle
-- produces nothing: `generateBillsForMeter` returns "no prior reading — first
-- cycle baseline, no bill produced" and moves on. That is correct behaviour and
-- an invisible one. A landlord onboarding mid-month enters the end-of-month
-- read, gets no bill, and receives no warning that a baseline was ever needed —
-- by the time it's noticeable the cycle has closed and the revenue is gone.
--
-- Oak Park hits this now: backdated baselines must exist before Aug 31 or
-- August bills nothing.
--
-- 'baseline' is its own reason rather than a 'monthly_cycle' read because it is
-- NOT a cycle read: the cycle-usage query looks for exactly one monthly_cycle
-- row per meter per month, and a baseline stamped that way would occupy that
-- slot and suppress the real read. The point-in-time "prior reading" lookup
-- filters on date only, not reason, so a baseline is correctly picked up as the
-- previous value without any change to the billing engine.
--
-- No backfill: meters created before this have no baseline, which is exactly the
-- condition the new warning surfaces.

ALTER TABLE utility_meter_readings
  DROP CONSTRAINT IF EXISTS utility_meter_readings_reason_check;

ALTER TABLE utility_meter_readings
  ADD CONSTRAINT utility_meter_readings_reason_check
  CHECK (reason = ANY (ARRAY[
    'monthly_cycle', 'stay_turnover', 'move_out_final', 'meter_replaced',
    'baseline',      -- S605: opening odometer, the first cycle's subtrahend
    'other'
  ]));

COMMENT ON COLUMN utility_meter_readings.reason IS
  'S605: monthly_cycle = the billed read; baseline = opening odometer captured at meter setup (never occupies the one-cycle-read-per-month slot); others are event reads.';

-- Finding submeters with no read at all is now a page-load query on the
-- utilities screen, not a rare report.
CREATE INDEX IF NOT EXISTS idx_utility_meter_readings_meter
  ON utility_meter_readings (meter_id);
