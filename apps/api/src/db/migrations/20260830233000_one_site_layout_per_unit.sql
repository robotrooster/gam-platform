-- S630 (Nic): "I tagged the spot as thirty, fifty, and pull through and back in,
-- and it doesn't give me any sort of warning that a unit can only be one."
--
-- 30 amp AND 50 amp is a real pedestal, so amp tags stack. A site is back-in or
-- pull-through and cannot be both, so layout tags do not. That rule belongs on
-- the table rather than in whichever screen happens to be writing: the unit page
-- toggles, the bulk classify endpoint, unit creation, and the landlord agent all
-- insert here, and enforcing it in four places means enforcing it in three.
--
-- Only DECLARED layouts count. A tag that says "Not specified" is a label with no
-- claim about the site — "Riverfront" is allowed to be exactly that — so it never
-- collides with anything.
CREATE OR REPLACE FUNCTION one_site_layout_per_unit() RETURNS trigger AS $$
DECLARE n int;
BEGIN
  SELECT count(DISTINCT s.rv_site_layout) INTO n
    FROM unit_subtype_links l
    JOIN property_unit_subtypes s ON s.id = l.subtype_id
   WHERE l.unit_id = NEW.unit_id
     AND s.rv_site_layout IS NOT NULL AND s.rv_site_layout <> 'none';
  IF n > 1 THEN
    RAISE EXCEPTION 'A site is back-in or pull-through, not both — pick one layout for this space.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_one_site_layout_per_unit ON unit_subtype_links;
CREATE TRIGGER trg_one_site_layout_per_unit
  AFTER INSERT ON unit_subtype_links
  FOR EACH ROW EXECUTE FUNCTION one_site_layout_per_unit();
