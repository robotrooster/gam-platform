-- S414 second fix-forward: narrow the partial UNIQUE index to only
-- type='rent'.
--
-- The prior migration's UNIQUE was on (unit_id, type, due_date) across
-- ALL types. That breaks generateMoveInInvoice (in moveInBundle.ts),
-- which legitimately INSERTs multiple type='fee' rows for the same
-- (unit, due_date) tuple — one per lease_fee (application_fee, pet_fee,
-- etc.). Each row references a distinct lease_fee_id; they're all valid.
--
-- The S407 bug being defended against — /initiate-rent-collection
-- double-billing — is RENT-specific. Other types (fee, deposit,
-- late_fee, utility, float_fee) don't have the same monthly-bill
-- idempotency constraint.
--
-- Drop the broad index, replace with rent-only.

DROP INDEX IF EXISTS ux_payments_unit_type_due_date_active;

CREATE UNIQUE INDEX ux_payments_unit_rent_due_date_active
  ON payments (unit_id, due_date)
  WHERE type = 'rent' AND status NOT IN ('failed', 'returned');

COMMENT ON INDEX ux_payments_unit_rent_due_date_active IS
  'S414/S407: prevents duplicate active rent payment rows for the same (unit, month). Failed and returned rows excluded so retry flows can insert fresh rows after a payment failure. Other payment types (fee, deposit, late_fee, etc.) are unconstrained — move-in invoices legitimately create multiple fee rows per (unit, due_date).';
