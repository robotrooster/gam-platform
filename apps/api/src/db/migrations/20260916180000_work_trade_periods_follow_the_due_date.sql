-- S648 (Nic, DIRECTIVE): "late fees and work trade settlement for anniversary
-- tenants should both count from each tenant's own due date."
--
-- A work-trade period was a calendar month, keyed by period_month. A tenant due
-- on the 15th works from the 15th to the 14th, so a period now carries its own
-- dates. period_month stays as the month LABEL (the month the period's bill is
-- due in) and keeps its aging arithmetic; the dates say which hours count.
--
-- Calendar periods (due on the 1st) are unchanged in every respect: their start
-- IS the label and their end is the month's last day, and the 1st-of-month close
-- keeps settling them exactly as before. Periods on another due day are closed
-- the day after they end, once (close_run_at), so a period left open to catch
-- up is never counted a second time.
--
-- Backfill: every existing row is a calendar period. close_run_at is stamped on
-- the ones whose month has already been through a 1st-of-month close.
ALTER TABLE work_trade_settlements
  ADD COLUMN IF NOT EXISTS period_start date,
  ADD COLUMN IF NOT EXISTS period_end date,
  ADD COLUMN IF NOT EXISTS close_run_at timestamptz;

UPDATE work_trade_settlements
   SET period_start = period_month,
       period_end = (period_month + INTERVAL '1 month' - INTERVAL '1 day')::date
 WHERE period_start IS NULL;

UPDATE work_trade_settlements
   SET close_run_at = COALESCE(settled_at, billed_at, NOW())
 WHERE close_run_at IS NULL
   AND period_end < date_trunc('month', NOW() AT TIME ZONE 'America/Phoenix')::date
   AND period_end < (NOW() AT TIME ZONE 'America/Phoenix')::date
   AND status <> 'open';

ALTER TABLE work_trade_settlements
  ALTER COLUMN period_start SET NOT NULL,
  ALTER COLUMN period_end SET NOT NULL;
ALTER TABLE work_trade_settlements
  ADD CONSTRAINT work_trade_settlements_period_dates CHECK (period_end >= period_start);

DROP INDEX IF EXISTS ux_work_trade_settlements_agreement_month;
CREATE UNIQUE INDEX ux_work_trade_settlements_agreement_start
  ON work_trade_settlements (agreement_id, period_start);
