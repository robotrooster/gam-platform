-- contractors.active becomes a projection of contractors.status.
--
-- The table arrived (empty, from an abandoned directory idea) with an `active`
-- boolean, and the marketplace migration an hour earlier added a `status` text
-- with 'active' / 'suspended' / 'retired' — because "suspended" and "retired"
-- are different facts a boolean cannot hold. That left TWO columns for one
-- fact, which is the drift trap CLAUDE.md's single-source rule exists to stop:
-- one UPDATE touches status, another touches active, and from then on the two
-- disagree with nobody the wiser.
--
-- Rather than drop a column (GAM keeps everything) or trust every future call
-- site to set both, `active` is now written BY the database from `status` on
-- every insert and update. It cannot be set to a value that contradicts
-- status, so a reader of either column gets the same answer forever.
--
-- No backfill needed: zero rows. The trigger would correct them anyway.

CREATE OR REPLACE FUNCTION contractor_active_follows_status() RETURNS trigger AS $$
BEGIN
  NEW.active := (NEW.status = 'active');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS contractors_active_follows_status ON contractors;
CREATE TRIGGER contractors_active_follows_status
  BEFORE INSERT OR UPDATE ON contractors
  FOR EACH ROW EXECUTE FUNCTION contractor_active_follows_status();
