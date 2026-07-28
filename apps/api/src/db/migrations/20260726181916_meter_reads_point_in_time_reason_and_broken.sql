-- S559 — Point-in-time meter reads + read reason + broken-meter status.
--
-- WHY: RV/extended-stay submetered spots turn over constantly (sometimes
-- several times a month, occasionally same-day). The old model stored ONE
-- read per meter per billing_cycle_month (UNIQUE meter_id+cycle), which
-- cannot represent a mid-month turnover read whose only job is to reset the
-- baseline so a departing short-term guest's usage stays off the next
-- arrival's bill. This makes reads point-in-time: a meter may have as many
-- reads as actually happen; usage is measured from the immediately previous
-- read by time; any read resets the baseline. The MONTHLY billing cycle is
-- preserved by keeping exactly one reason='monthly_cycle' read per meter per
-- cycle (partial unique index), so nothing in the invoice cycle changes.
--
-- Also adds the read REASON (billing-intent vs reference/baseline; single
-- source packages/shared METER_READ_REASONS) and a broken-meter status so a
-- meter that's out of service can bill an ESTIMATE from comparable units
-- instead of $0.

-- 1. Read reason. Existing rows are all cycle reads → default monthly_cycle.
--    No backfill needed beyond the default. CHECK mirrors METER_READ_REASONS.
ALTER TABLE utility_meter_readings
  ADD COLUMN reason text NOT NULL DEFAULT 'monthly_cycle'
    CONSTRAINT utility_meter_readings_reason_check
    CHECK (reason IN ('monthly_cycle','stay_turnover','move_out_final','meter_replaced','other')),
  ADD COLUMN reason_note text;

-- 2. Point-in-time: drop the one-read-per-cycle constraint and replace it
--    with a PARTIAL unique index that still guarantees a single monthly_cycle
--    read per meter per cycle. Reference reads (turnover/replaced/other) are
--    unconstrained, so a spot can be read any number of times in a month.
ALTER TABLE utility_meter_readings
  DROP CONSTRAINT utility_meter_readings_meter_id_billing_cycle_month_key;

CREATE UNIQUE INDEX utility_meter_readings_one_cycle_read_per_month
  ON utility_meter_readings (meter_id, billing_cycle_month)
  WHERE reason = 'monthly_cycle';

-- Prior-read lookups now order by time, not cycle month. Index supports
-- "most recent read strictly before this one on a meter".
CREATE INDEX utility_meter_readings_meter_time_idx
  ON utility_meter_readings (meter_id, reading_date DESC, created_at DESC);

-- 3. Broken-meter status. A submeter marked out of service bills an estimate
--    (average usage of comparable units) until a real read is taken again.
--    Safe drop: additive, defaults keep every existing meter in service.
ALTER TABLE utility_meters
  ADD COLUMN out_of_service boolean NOT NULL DEFAULT false,
  ADD COLUMN out_of_service_since date;
