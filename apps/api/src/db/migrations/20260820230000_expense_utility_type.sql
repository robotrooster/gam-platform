-- S613 (Nic): "Unbilled utility tracking would just be the difference between an
-- owner importing their total charges coming into the property and subtracting
-- the outgoing charges... They can put it as a utility bill electric or whatever,
-- utility bill water, and add the dollar amount."
--
-- He is right and I had over-built the idea. The TOTAL not recovered is money in
-- minus money out, and both sides already exist: landlord_expenses on one side,
-- utility_bills on the other. No new per-share ledger is needed for the headline
-- number, and the owner-occupied slice of it is already recorded separately.
--
-- The one thing missing is WHICH utility an expense was for. There is a single
-- 'utilities' category, so an electric bill and a water bill land in one bucket
-- and the report can only ever say "utilities" — it could never tell him that
-- water recovers 90% and electric recovers 40%, which is the comparison worth
-- having. Kept as a field on the existing category rather than as five new
-- categories, so the bookkeeping vocabulary doesn't fan out.
ALTER TABLE landlord_expenses
  ADD COLUMN IF NOT EXISTS utility_type text
  CHECK (utility_type IS NULL OR utility_type = ANY (ARRAY['water','gas','electric','sewer','trash','propane']));

COMMENT ON COLUMN landlord_expenses.utility_type IS
  'S613: which utility this expense was for, when category = utilities. NULL is '
  'fine and means "utilities, unspecified" — it still counts in the total spent.';
