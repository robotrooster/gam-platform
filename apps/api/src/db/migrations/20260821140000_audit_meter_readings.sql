-- S613 (Nic, mid-walk): "I just fat fingered an opening meter read. I need a way
-- to edit it... I have no way to edit my accidental bad read."
--
-- There was no way, because there was no route — a reading could be created and
-- never corrected. Before adding one, the readings table gets the audit trigger
-- every other correctable money-adjacent table already has: a meter reading is
-- the number a tenant's bill is computed from, so what it used to say, and when
-- it changed, has to survive the correction. GAM keeps everything.
CREATE TRIGGER audit_utility_meter_readings
  AFTER DELETE OR UPDATE ON utility_meter_readings
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
