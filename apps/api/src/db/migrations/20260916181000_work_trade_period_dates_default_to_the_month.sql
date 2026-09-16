-- S648: a period written without dates is a calendar-month period — the only
-- kind there was before 20260916180000. Filled in on the way in so no writer
-- (old code, a script, a test) can create a period with no range.
CREATE OR REPLACE FUNCTION work_trade_period_default_dates() RETURNS trigger AS $$
BEGIN
  IF NEW.period_start IS NULL THEN NEW.period_start := NEW.period_month; END IF;
  IF NEW.period_end IS NULL THEN
    NEW.period_end := (date_trunc('month', NEW.period_start) + INTERVAL '1 month' - INTERVAL '1 day')::date;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_work_trade_period_default_dates
  BEFORE INSERT ON work_trade_settlements
  FOR EACH ROW EXECUTE FUNCTION work_trade_period_default_dates();
