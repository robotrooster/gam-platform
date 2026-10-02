-- S654: a property's time zone now decides its business dates (invoices, due
-- dates, credit-record tiers, late fees). An unrecognized zone would make
-- Postgres raise 22023 inside sync_unit_delinquency(), a trigger on payments,
-- and roll back a Stripe rent settlement on every retry. Production holds no
-- bad zones today (7 properties, 4 real zones); this keeps it that way by
-- refusing an unknown zone when a property is written, from any door (CSV
-- import, agent tools, the API). A trigger, not a CHECK, because the test reads
-- pg_timezone_names, which a CHECK must not depend on.
--
-- Additive (expand). Existing rows are not re-checked; no backfill needed.
CREATE OR REPLACE FUNCTION properties_timezone_must_be_real() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.timezone IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Unknown time zone "%" for a property', NEW.timezone USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_properties_timezone_real ON properties;
CREATE TRIGGER trg_properties_timezone_real
  BEFORE INSERT OR UPDATE OF timezone ON properties
  FOR EACH ROW EXECUTE FUNCTION properties_timezone_must_be_real();
