-- POS refunds: drop 'card', add 'check' (S339)
--
-- Product decision (Nic-confirmed S339):
--   POS refunds are CASH or CHECK only at user (cashier) discretion.
--   GAM does not process refunds back to a card via Stripe — the
--   refund endpoint is pure record-keeping for a cashier-physical
--   payout from the till or check book.
--
-- FlexCharge sales keep 'charge' as the symmetric reversal (credit
-- back to the open account). The refund endpoint validates the
-- cashier's choice against this enum based on the original payment
-- method:
--   - tx.payment_method = 'charge' → refund_method = 'charge' (forced)
--   - tx.payment_method = 'cash' or 'card' → cashier picks 'cash' or 'check'
--
-- No-backfill note: dev DB has zero pos_refunds rows pre-launch
-- (verified at S339 close). Defensive UPDATE flips any 'card' rows
-- to 'cash' before the CHECK swap — safe no-op if no such rows.

UPDATE pos_refunds SET refund_method = 'cash' WHERE refund_method = 'card';

ALTER TABLE pos_refunds DROP CONSTRAINT pos_refunds_method_check;
ALTER TABLE pos_refunds ADD CONSTRAINT pos_refunds_method_check
  CHECK (refund_method = ANY (ARRAY['cash'::text, 'check'::text, 'charge'::text]));
