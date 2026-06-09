-- S94 / Item 14 follow-up: link pos_transactions to the Stripe Terminal
-- card-present PaymentIntent that funded it.
--
-- Pre-S94 the terminal.ts route created + captured a PaymentIntent but
-- never wrote anything back to pos_transactions — card sales had no
-- audit trail tying the GAM-side row to the Stripe-side charge.
-- Cash + tenant-charge sales already wrote a pos_transactions row via
-- POST /api/pos/transactions; this column lets the same route absorb
-- card sales by stamping the PI id from the capture response.
--
-- Partial UNIQUE for idempotency. A frontend retry after capture
-- succeeded but before the record-back POST returned would otherwise
-- double-write. The 23505 catch in the route turns it into a clean 409.
-- NULL is fine for cash + charge transactions where no Stripe PI exists.

ALTER TABLE pos_transactions
  ADD COLUMN stripe_payment_intent_id text;

CREATE UNIQUE INDEX pos_transactions_stripe_pi_uniq
  ON pos_transactions(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
