-- S631 (Nic): "My brother can input the electric meter reads himself, but the
-- water bill comes to me in the mail, so I would have to do those. Can it be two
-- separate flows for the end-of-month system where people are putting in
-- information relevant to their role?"
--
-- Reads were always enterable one meter at a time, in any order, by anyone with
-- the reading permission — so two people could always split the walk. What they
-- could NOT do is finish. A run covered every readable meter on the property and
-- only moved to verification once the last one was in, so a fully-read electric
-- walk sat there billing nothing until a water bill arrived in the post days
-- later. One person waiting on a different utility blocked the other's billing.
--
-- A run is now scoped to a utility. Electric completes, verifies and bills the
-- moment the electric meters are read; water does the same whenever the envelope
-- turns up. That also matches who holds the information: the person walking the
-- park has the electric registers, the person opening the mail has the water.
--
-- NULL means "every utility", which is what the three existing runs are and how
-- a property with a single reader keeps working. The unique index uses
-- COALESCE so a NULL-scoped run and a typed one cannot both cover electric in
-- the same cycle — plain NULLs compare distinct and would have allowed exactly
-- that pair of overlapping runs.
ALTER TABLE utility_reading_runs
  ADD COLUMN IF NOT EXISTS utility_type text;

COMMENT ON COLUMN utility_reading_runs.utility_type IS
  'S631: the utility this run covers, so each bills as soon as its own reads are in. NULL = every readable meter on the property (the original whole-property run).';

ALTER TABLE utility_reading_runs
  DROP CONSTRAINT IF EXISTS utility_reading_runs_property_id_billing_cycle_month_key;
DROP INDEX IF EXISTS utility_reading_runs_property_cycle_utility;
CREATE UNIQUE INDEX utility_reading_runs_property_cycle_utility
  ON utility_reading_runs (property_id, billing_cycle_month, COALESCE(utility_type, 'all'));
