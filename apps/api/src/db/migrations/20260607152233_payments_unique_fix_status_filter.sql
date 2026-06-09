-- S414 fix-forward: the prior migration
-- 20260607151930_payments_unique_per_unit_month.sql used
-- `WHERE status != 'cancelled'`, but 'cancelled' is not a valid value
-- per payments_status_check (ARRAY['pending', 'processing', 'settled',
-- 'failed', 'returned', 'paid_via_deposit']). The filter was a no-op.
--
-- The product intent is: prevent duplicate ACTIVE/PENDING rows for the
-- same (unit, type, month) so /initiate-rent-collection can't
-- double-bill. If a row is 'failed' or 'returned', the system may
-- legitimately insert a fresh row to retry that month — so those
-- statuses should NOT block a re-insert.
--
-- Drop the bad index and recreate with the correct exclusion.

DROP INDEX IF EXISTS ux_payments_unit_type_due_date_active;

CREATE UNIQUE INDEX ux_payments_unit_type_due_date_active
  ON payments (unit_id, type, due_date)
  WHERE status NOT IN ('failed', 'returned');

COMMENT ON INDEX ux_payments_unit_type_due_date_active IS
  'S414/S407: prevents duplicate active payment rows for the same (unit, type, month). Failed and returned rows are excluded so retry flows can insert fresh rows after a payment failure.';
