-- S652 — DOCUMENTS AND PACKAGES BELONG TO THE ACCOUNT, NOT TO ONE COMPANY.
--
-- Nic: "Why the fuck does the company matter in this? A person that owns a
-- property or has a property listed in any state should be able to set a
-- package for that state. Doesn't matter what company it's for... The landlord
-- portal does not need to be linked to any one company. It's linked to
-- everything that's under their purview."
--
-- lease_templates.landlord_id / document_packages.landlord_id stay as the
-- company a thing is FILED under, but nothing may require it to MATCH the
-- company of the unit or lease it is used on. The test is "is it within the
-- purview of the people who run this company": every company that shares an
-- owner or member with it. Blu runs Country Acres and is an owner-member of Oak
-- Park, so a Country Acres lease may use an Oak Park template and vice versa;
-- Nic's Mountain View (not Blu's) stays out of Blu's reach.
--
-- A SQL function so every lookup — a person clicking, a nightly renewal with no
-- person at all — asks the same question the same way.
CREATE OR REPLACE FUNCTION account_companies(company uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  WITH people AS (
    SELECT user_id FROM landlord_members WHERE landlord_id = company
    UNION
    SELECT user_id FROM landlords WHERE id = company AND user_id IS NOT NULL
  )
  SELECT landlord_id FROM landlord_members WHERE user_id IN (SELECT user_id FROM people)
  UNION
  SELECT id FROM landlords WHERE user_id IN (SELECT user_id FROM people)
  UNION
  SELECT company
$$;
