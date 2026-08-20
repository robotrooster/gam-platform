-- S607 (Nic, DIRECTIVE): drop two allocation bases from the menu.
--
-- 'equal_split' — Nic: "we're not gonna do equal split because that's a stupid
--   method. Like, nobody's ever gonna opt to do that." He is right, and the
--   S607 recovery tests showed why in numbers: equal_split hands a VACANT unit
--   a full share, that share then finds no tenant, and the landlord silently
--   eats it — a third of a $900 bill in the three-unit test. 'rented_spaces' is
--   the same idea done correctly (equal share across the units actually leased,
--   whole pool recovered), so equal_split was a strictly worse duplicate that
--   only existed to lose the landlord money.
--
-- 'weighted_occupancy' — Nic: "I don't know what weighted occupancy means. That
--   sounds like something too complicated for what we're doing." Added earlier
--   the same session while widening the menu; removed before anyone could pick
--   it. Occupancy handles the fairness case plainly, and a basis the landlord
--   cannot explain to a tenant at the door is not worth having.
--
-- Widening the menu was the right instinct — the point was to fit how landlords
-- across the country bill, not to pile up choices. Options nobody would choose
-- are not flexibility, they are noise on the one screen that decides how every
-- tenant on a meter gets charged.
--
-- SAFE: verified zero rows use either value before writing this (all live
-- masters are 'occupant_count'). Nothing to backfill and nothing to rewrite —
-- but the DO block below refuses to run if that ever stops being true, rather
-- than letting the constraint fail halfway with a confusing error.
--
-- utility_bills.allocation_method is deliberately NOT constrained: it is a
-- SNAPSHOT of how an issued bill was calculated, and history must keep saying
-- what actually happened even after a basis leaves the menu.

DO $$
DECLARE n integer;
BEGIN
  SELECT COUNT(*) INTO n FROM utility_meters
   WHERE rubs_allocation_method IN ('equal_split', 'weighted_occupancy');
  IF n > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop equal_split/weighted_occupancy: % meter(s) still use one. Move them to rented_spaces or occupant_count first.', n;
  END IF;
END $$;

ALTER TABLE utility_meters
  DROP CONSTRAINT IF EXISTS utility_meters_rubs_allocation_method_check;
ALTER TABLE utility_meters
  ADD CONSTRAINT utility_meters_rubs_allocation_method_check
  CHECK (rubs_allocation_method = ANY (ARRAY[
    'occupant_count'::text, 'sqft'::text, 'bedrooms'::text,
    'rented_spaces'::text, 'fixture_count'::text,
    'unit_type_weight'::text, 'hybrid'::text]));
