-- The marketplace's insured/bonded gate reads the ONE insurance home.
--
-- THIS FILE REPLACES TWO, AND IT SITS WHERE IT DOES ON PURPOSE. The projection
-- was written as 20261101002000 plus a fix at 002100, both of which attach a
-- trigger to `insurance_policies` — a table created by 20261101010000, EIGHT
-- timestamps later. They worked on `gam` only because of the order they were
-- written in that evening: 010000 was applied at 17:01, when it was the only
-- pending file, and 002000 was not written until 17:40. Filename order and the
-- order they actually ran in were not the same thing.
--
-- Any other database then could not catch up. `gam_demo`, 24 migrations behind,
-- stopped dead on "relation insurance_policies does not exist", because a
-- database with both files pending runs them in FILENAME order. So the two are
-- deleted and this one carries their final content at a timestamp after the
-- table it depends on. Fix-forward does not help here: the problem is a file
-- that cannot run, and no later file can make an earlier one run sooner.
--
-- WHY A TRIGGER rather than code in the route: the same reason
-- contractors.active follows contractors.status. A policy can be recorded,
-- verified, edited, voided, or cascade away with its contractor, from a route,
-- a lease parser, a script, or a screen nobody has written yet. Any call site
-- that forgot to recompute would leave a landlord's insured-contractor
-- requirement being judged against a policy that expired or was voided months
-- ago. The database keeps the four columns true instead.
--
-- A policy counts toward the gate only when it is VERIFIED and NOT VOIDED —
-- GAM confirming the certificate is what a landlord relies on, so an
-- unconfirmed upload must not flip the flag. The expiry taken is the LATEST
-- among the ones that count, so renewing extends the cover and an old expired
-- certificate sitting beside a current one cannot drag it back.
--
-- COUNT(*) > 0, NOT a literal beside MAX(). The first draft computed
-- `SELECT TRUE AS has_cover, MAX(expiry_date) ... WHERE <no match>`, and an
-- aggregate with no GROUP BY returns ONE row even when nothing matches. So
-- has_cover was TRUE unconditionally and every contractor read as insured — the
-- exact failure the gate exists to prevent, caught by the marketplace suite's
-- own projection tests before it reached anything real.
--
-- Idempotent: CREATE OR REPLACE for both functions, DROP TRIGGER IF EXISTS
-- before CREATE TRIGGER, and a recompute at the end that is correct however
-- many times it runs. So re-applying it over a database that already has the
-- trigger changes nothing.
--
-- No backfill needed in substance, but the recompute runs over every contractor
-- anyway, so the columns are right from the moment this applies rather than
-- from the next policy write.

CREATE OR REPLACE FUNCTION contractor_insurance_projection(p_contractor_id uuid)
RETURNS void AS $$
BEGIN
  IF p_contractor_id IS NULL THEN RETURN; END IF;
  UPDATE contractors c SET
    insurance_verified = gl.has_cover,
    insurance_expiry   = gl.until,
    bond_verified      = sb.has_cover,
    bond_expiry        = sb.until,
    updated_at         = NOW()
  FROM (
    SELECT
      (SELECT COUNT(*) > 0 FROM insurance_policies
        WHERE contractor_id = p_contractor_id AND coverage_type = 'general_liability'
          AND verified_at IS NOT NULL AND voided_at IS NULL) AS has_cover,
      (SELECT MAX(expiry_date) FROM insurance_policies
        WHERE contractor_id = p_contractor_id AND coverage_type = 'general_liability'
          AND verified_at IS NOT NULL AND voided_at IS NULL) AS until
  ) gl,
  (
    SELECT
      (SELECT COUNT(*) > 0 FROM insurance_policies
        WHERE contractor_id = p_contractor_id AND coverage_type = 'surety_bond'
          AND verified_at IS NOT NULL AND voided_at IS NULL) AS has_cover,
      (SELECT MAX(expiry_date) FROM insurance_policies
        WHERE contractor_id = p_contractor_id AND coverage_type = 'surety_bond'
          AND verified_at IS NOT NULL AND voided_at IS NULL) AS until
  ) sb
  WHERE c.id = p_contractor_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION insurance_policy_projects_to_contractor() RETURNS trigger AS $$
BEGIN
  -- An UPDATE may move a policy from one contractor to another; recompute both.
  IF TG_OP <> 'INSERT' AND OLD.contractor_id IS NOT NULL THEN
    PERFORM contractor_insurance_projection(OLD.contractor_id);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.contractor_id IS NOT NULL THEN
    PERFORM contractor_insurance_projection(NEW.contractor_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS insurance_policies_project_to_contractor ON insurance_policies;
CREATE TRIGGER insurance_policies_project_to_contractor
  AFTER INSERT OR UPDATE OR DELETE ON insurance_policies
  FOR EACH ROW EXECUTE FUNCTION insurance_policy_projects_to_contractor();

-- Make every existing contractor's four columns true right now.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM contractors LOOP
    PERFORM contractor_insurance_projection(r.id);
  END LOOP;
END $$;
