-- S609: one carried balance per lease, enforced by the database.
--
-- FOUND BY THE S594 IDEMPOTENCY GUARD. `carried_balance` (the opening balance a
-- landlord carries over from previous management) was added as a payments type
-- without ever being declared in moneyIdempotency.test.ts — the guard exists to
-- make exactly that loud, and it fired the moment schema.sql was regenerated.
-- Pre-existing; surfaced here, not caused here.
--
-- The route already intends this rule and says so:
--
--   "One carried balance per lease. A second would almost always be a
--    double-entry of the same debt."
--
-- But it enforced it by SELECTing for an existing opening-balance invoice and
-- then inserting — a read-then-write with nothing between. Two clicks on a slow
-- connection, or a retried request, and both checks pass before either insert
-- lands. The tenant then owes an old debt twice, on a charge type a landlord
-- types in by hand, with no cron and no unique index to catch it.
--
-- This makes the rule true rather than intended. The route's own check stays —
-- it produces the friendly 409 ("edit or void the existing one instead"); this
-- index is the backstop that makes the race impossible rather than unlikely.
--
-- SAFE: partial index over an existing rule. It fails to build only if some
-- lease ALREADY has two opening balances, which would itself be the bug.

CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_one_opening_balance_per_lease
  ON invoices (lease_id) WHERE is_opening_balance;

COMMENT ON INDEX ux_invoices_one_opening_balance_per_lease IS
  'S609: a lease may carry exactly one opening balance. The route checks first for a friendly error; this makes the rule impossible to race past.';
