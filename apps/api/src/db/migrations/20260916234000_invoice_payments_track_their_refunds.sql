-- S648: an invoice can be paid in parts — an online deposit, then the balance
-- online or in cash. A refund has to go back against the payments that were
-- actually made (a Stripe refund can't exceed its own charge), so each payment
-- now carries how much of it has been refunded.
--
-- method now covers every way an invoice is paid: 'card' / 'ach' online, and
-- the manual methods "mark paid" records (cash, check, ach, card, other).
-- One row per PaymentIntent (the recurring auto-charge now writes one too).
-- No backfill: no invoice payments exist yet (verified).
ALTER TABLE business_invoice_payments
  ADD COLUMN refunded_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT business_invoice_payments_refund_bounds CHECK (refunded_amount >= 0 AND refunded_amount <= amount),
  ADD CONSTRAINT business_invoice_payments_method_check CHECK (method IN ('card', 'ach', 'cash', 'check', 'other'));
CREATE UNIQUE INDEX business_invoice_payments_pi_key
  ON business_invoice_payments (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
