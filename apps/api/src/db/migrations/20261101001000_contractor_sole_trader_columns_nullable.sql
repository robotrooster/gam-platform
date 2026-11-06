-- A contractor does not have to be a company.
--
-- Found by the marketplace's own test suite, and it was a real production bug:
-- the `contractors` table arrived from the abandoned directory idea with
-- business_name, phone and email all NOT NULL. That shape assumed every
-- contractor is a registered business with a published number and address —
-- which is exactly wrong for the people this marketplace is for. Nic's example
-- is a one-man operation: "A landscaper trying to get more yards." Bob with a
-- truck has a name and a phone and no LLC, and he must not be forced to invent
-- a company name to bid on a job.
--
-- Without this, PUT /api/marketplace/me returned a 500 to any sole trader who
-- left the business-name field blank.
--
-- `name` stays NOT NULL: a bid has to come from somebody, and a landlord
-- deciding who to let onto their park is entitled to a name.
--
-- No backfill needed: zero rows.

ALTER TABLE contractors ALTER COLUMN business_name DROP NOT NULL;
ALTER TABLE contractors ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE contractors ALTER COLUMN email DROP NOT NULL;

-- At least one way to reach them, though — a contractor nobody can contact
-- cannot be awarded work. One of the two, not both.
ALTER TABLE contractors DROP CONSTRAINT IF EXISTS contractors_reachable;
ALTER TABLE contractors ADD CONSTRAINT contractors_reachable
  CHECK (phone IS NOT NULL OR email IS NOT NULL OR user_id IS NOT NULL);
