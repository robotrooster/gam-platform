-- S553: audit trail on entity ownership changes (partnership-dissolution
-- protection). When partnerships sour, "who removed whom and when" must be
-- provable — membership deletes/updates land in the platform audit journal
-- like lease_tenants and service_interruptions already do.
-- No backfill needed: trigger-only.

CREATE TRIGGER audit_landlord_members
  AFTER DELETE OR UPDATE ON landlord_members
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
