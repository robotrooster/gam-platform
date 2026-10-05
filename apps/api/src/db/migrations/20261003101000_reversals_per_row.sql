-- S655 money plan M11 (Step 1). Expand-only: a unique index that every existing
-- row satisfies (the old one-per-event constraint is stricter), and a relaxed
-- check on held_payout_items.
--
-- A dispute or return reopens EVERY row its charge paid, one reversal record
-- per row. The old UNIQUE(stripe_event_id) stays until C0 so the running code's
-- ON CONFLICT (stripe_event_id) keeps working until the API restarts.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_reversals_event_payment
  ON payment_reversals (stripe_event_id, payment_id);
COMMENT ON INDEX ux_payment_reversals_event_payment IS
  'S655: a dispute or return reopens EVERY row its charge paid, one reversal record per row (reversed_amount = what that row lost). C0 drops the old one-per-event constraint.';

-- Move-out under GAM escrow: when the landlord holds more paid-ahead money than
-- its deductions, the settlement is negative and is netted from the next
-- payout as a negative deposit_settlement item. Mirrored by
-- HELD_PAYOUT_SOURCE_TYPES in packages/shared/src/money.ts.
ALTER TABLE held_payout_items DROP CONSTRAINT IF EXISTS held_payout_items_source_type_check;
ALTER TABLE held_payout_items ADD CONSTRAINT held_payout_items_source_type_check
  CHECK (source_type IN ('pos_sale','booking_deposit','business_invoice_payment','business_pos_sale',
                         'refund','dispute','platform_fee','prepaid_draw','deposit_settlement'));
