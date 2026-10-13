-- 10/11 (Nic) — THE CHANGE JOURNAL RECORDS WHO WAS GIVEN WHICH BOOKS
--
-- A bookkeeper now keeps exactly the properties ticked for them, one box per
-- property. The journal (audit_row_changes, S550) already records every change
-- to those boxes and every removal (AFTER UPDATE OR DELETE). It did not record
-- the grant itself: accepting an invitation INSERTs the bookkeeper_scopes row,
-- and S550 journaled no INSERT anywhere ("the live row IS the record of an
-- insert"). For an access grant that is not enough — the row is edited and
-- removed later, and then nothing says what was first given, or when. The
-- invitation's platform_event names the person, not the properties.
--
-- So bookkeeper_scopes journals its INSERTs too:
--   * audit_row_changes.op may now be 'INSERT'; such a row carries the new row
--     in new_row and has no old_row (NULL), the mirror of a DELETE.
--   * audit_row_change() learns the INSERT case. Every other table's trigger
--     still fires on UPDATE OR DELETE only, so nothing else starts journaling
--     inserts; their rows and every existing reader (which all filter
--     op = 'UPDATE') are unchanged.
--   * audit_bookkeeper_scopes is recreated AFTER INSERT OR UPDATE OR DELETE.
--
-- Backfill: none possible — the grants made before today were not journaled;
-- their rows (created_at) stand for them.
-- Safe drop: recreate the trigger AFTER DELETE OR UPDATE, delete the INSERT
-- journal rows, restore old_row NOT NULL and the op CHECK to UPDATE/DELETE.

ALTER TABLE audit_row_changes ALTER COLUMN old_row DROP NOT NULL;

ALTER TABLE audit_row_changes DROP CONSTRAINT audit_row_changes_op_check;
ALTER TABLE audit_row_changes ADD CONSTRAINT audit_row_changes_op_check
  CHECK (op IN ('INSERT', 'UPDATE', 'DELETE'));

-- An UPDATE or DELETE row still always carries the row as it was.
-- 10/12 (Nic): dropped first so the whole file re-runs cleanly, like the op
-- CHECK above. routes/bookkeeperPropertyBoxes.test.ts applies this file inside
-- a rolled-back transaction; once schema.sql is regenerated with it, a bare
-- ADD would fail with "already exists".
ALTER TABLE audit_row_changes DROP CONSTRAINT IF EXISTS audit_row_changes_old_row_present;
ALTER TABLE audit_row_changes ADD CONSTRAINT audit_row_changes_old_row_present
  CHECK (op = 'INSERT' OR old_row IS NOT NULL);

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
  ELSIF TG_OP = 'INSERT' THEN
    -- 10/11: only tables whose trigger names INSERT get here (bookkeeper_scopes).
    INSERT INTO audit_row_changes (table_name, row_id, op, old_row, new_row)
    VALUES (TG_TABLE_NAME, (to_jsonb(NEW)->>'id')::uuid, 'INSERT', NULL, to_jsonb(NEW));
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_bookkeeper_scopes ON bookkeeper_scopes;
CREATE TRIGGER audit_bookkeeper_scopes
  AFTER INSERT OR UPDATE OR DELETE ON bookkeeper_scopes
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
