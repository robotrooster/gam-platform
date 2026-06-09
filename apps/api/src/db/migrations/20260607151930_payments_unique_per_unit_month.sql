-- S414 (S407 follow-on): bulletproof UNIQUE constraint on payments
-- against the duplicate-rent-charge race window that the S407 SELECT-
-- then-skip guard left open.
--
-- Pre-fix path:
--   S407 added a `SELECT ... LIMIT 1` guard inside
--   POST /initiate-rent-collection that skips an INSERT when a
--   matching (unit_id, type, due_date) row already exists. That
--   defends against sequential repeat invocations (admin double-click,
--   scheduler retry) but leaves a residual race: two concurrent calls
--   in the same millisecond could both pass the SELECT and both
--   INSERT, producing duplicates.
--
-- Fix:
--   Partial UNIQUE index covering the non-cancelled subset. Cancelled
--   rows are excluded because the product allows a tenant to have
--   multiple cancelled rent rows for the same month (e.g., billed,
--   refunded, re-billed).
--
-- Dev verification:
--   Confirmed zero existing duplicates in the dev DB before applying
--   (the S407 guard has kept the table clean since shipping).

CREATE UNIQUE INDEX ux_payments_unit_type_due_date_active
  ON payments (unit_id, type, due_date)
  WHERE status != 'cancelled';

COMMENT ON INDEX ux_payments_unit_type_due_date_active IS
  'S414/S407: prevents duplicate payment rows for the same (unit, type, month). The route-layer SELECT-then-skip in /initiate-rent-collection is the primary defense; this index closes the residual concurrent-write race.';
