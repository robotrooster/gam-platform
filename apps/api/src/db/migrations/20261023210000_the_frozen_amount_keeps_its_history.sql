-- 10/22 (Nic) — THE CHANGE JOURNAL ON A DEBT SOMEBODY WALKED AWAY FROM.
--
-- The table landed 10/21 without its audit trigger, which CLAUDE.md requires of
-- every table that holds money ("Every table that holds money gets the trigger
-- in the migration that creates it"). The guards caught it before anything
-- deployed — ledgerSourceFacts and ledgerCoverage both refused the build.
--
-- It matters more here than the rule alone suggests. Nic, 10/22:
--
--   "If the original landlord tries to change the amount after it's recorded in
--    GAM, that's going to be handled completely outside of GAM... So no, the
--    price cannot move in the platform."
--
--   "we don't want people fraudulently trying to create things later on... It
--    protects the other tenant from getting scammed."
--
-- The whole trustworthiness of this number rests on it never moving after
-- import. A rule that a figure cannot change is worth exactly as much as the
-- record proving it did not — and audit_row_changes is the only record of what
-- a money row said before somebody changed it, and is never pruned.
DROP TRIGGER IF EXISTS audit_tenant_left_owing ON tenant_left_owing;
CREATE TRIGGER audit_tenant_left_owing
  AFTER UPDATE OR DELETE ON tenant_left_owing
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- The reveal log has no money column, but it records who took on somebody
-- else's debt — not a thing to be remembered differently by the two parties.
DROP TRIGGER IF EXISTS audit_tenant_left_owing_reveals ON tenant_left_owing_reveals;
CREATE TRIGGER audit_tenant_left_owing_reveals
  AFTER UPDATE OR DELETE ON tenant_left_owing_reveals
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
