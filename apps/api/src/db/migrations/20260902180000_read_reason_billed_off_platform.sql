-- S636 (Nic): "Mark the system units where, when I bill them off platform, I can
-- update the baseline read or take a new read. I need to be able to do that
-- separately from a tenancy move out or a reservation ending."
--
-- Mountain View arrived on GAM mid-tenancy, so several spots had occupants the
-- platform never knew about who have since left. Their electric is real and
-- recorded — RV 37 alone is 530 kWh — but there is no tenant to invoice, so Nic
-- collects it himself. Two things then have to happen, and neither had a name:
-- the record has to say WHY that usage was never invoiced, and the meter has to
-- start fresh so the next arrival is not handed a stranger's usage.
--
-- `move_out_final` is wrong for this (it BILLS a departing responsible tenant),
-- `stay_turnover` is wrong (system-stamped off the reservation calendar), and
-- `other` says nothing. This reason is reference-only, never bills, and — like
-- every non-cycle read — becomes the next cycle's starting point, because the
-- engine takes the most recent prior read whatever its reason.
--
-- BACKFILL: none. No existing reading changes.
ALTER TABLE utility_meter_readings
  DROP CONSTRAINT IF EXISTS utility_meter_readings_reason_check;

ALTER TABLE utility_meter_readings
  ADD CONSTRAINT utility_meter_readings_reason_check
  CHECK (reason = ANY (ARRAY[
    'monthly_cycle', 'stay_turnover', 'move_out_final', 'meter_replaced',
    'baseline', 'billed_off_platform', 'other']));
