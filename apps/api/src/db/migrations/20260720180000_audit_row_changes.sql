-- S550 (Nic): the change journal — "any data point at any time" requires
-- that in-place UPDATEs and DELETEs stop destroying history. A generic
-- trigger captures every row version (old + new, jsonb) on the business
-- tables, at the database layer so NO code path can skip it (routes, crons,
-- manual SQL — everything journals).
--
-- What this buys: "what was this lease's rent before the edit, and when did
-- it change" / "what did the deleted booking look like" — answerable
-- forever, starting today. Acquisition-grade audit trail.
--
-- Deliberately EXCLUDED from v1: users + bank/credential tables (rows carry
-- password hashes / TOTP secrets / encrypted bank data — journaling them
-- would copy secrets into a second, less-guarded table). Attribution
-- (WHO changed it) rides in the row payloads where tables already carry
-- *_by columns; per-request actor propagation is a follow-up.
--
-- Storage: jsonb per change; trivial at launch scale, partitionable later.
-- INSERTs are NOT journaled (the live row IS the record of an insert;
-- snapshots + created_at cover birth).
-- No backfill possible: history starts now. That's the point.

CREATE TABLE audit_row_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name text NOT NULL,
  row_id uuid,                      -- the row's id when it has a uuid id
  op text NOT NULL CHECK (op IN ('UPDATE', 'DELETE')),
  old_row jsonb NOT NULL,
  new_row jsonb,                    -- NULL on DELETE
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_row_changes_table_row_idx ON audit_row_changes (table_name, row_id, changed_at);
CREATE INDEX audit_row_changes_changed_at_idx ON audit_row_changes (changed_at);

CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Skip no-op UPDATEs (same row written back) to keep the journal signal.
    IF to_jsonb(OLD) = to_jsonb(NEW) THEN RETURN NEW; END IF;
    INSERT INTO audit_row_changes (table_name, row_id, op, old_row, new_row)
    VALUES (TG_TABLE_NAME, (to_jsonb(OLD)->>'id')::uuid, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO audit_row_changes (table_name, row_id, op, old_row, new_row)
    VALUES (TG_TABLE_NAME, (to_jsonb(OLD)->>'id')::uuid, 'DELETE', to_jsonb(OLD), NULL);
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- The business tables whose history is the asset. One trigger each.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'landlords', 'properties', 'units', 'leases', 'lease_fees',
    'lease_tenants', 'tenants', 'payments', 'invoices', 'unit_bookings',
    'maintenance_requests', 'security_deposits', 'deposit_returns',
    'property_allocation_rules', 'property_unit_type_late_fees',
    'property_unit_subtypes', 'unit_inspections'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
      'audit_' || t, t);
  END LOOP;
END $$;
