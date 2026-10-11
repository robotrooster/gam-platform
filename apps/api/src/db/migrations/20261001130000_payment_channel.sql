-- S654 (Nic): "we need to show the difference between card online and card
-- in person in the transaction history."
--
-- payments.payment_channel: how the money was presented — 'online' (the
-- portal, autopay, an emailed link) or 'in_person' (a card tapped on the
-- counter's reader). Cash, checks and money orders carry manual_method and
-- leave this NULL. Every row that has ever settled through a Stripe
-- PaymentIntent so far was paid online, so the backfill is exact.
ALTER TABLE payments ADD COLUMN payment_channel text
  CHECK (payment_channel IS NULL OR payment_channel IN ('online', 'in_person'));
COMMENT ON COLUMN payments.payment_channel IS 'S654: online (portal / autopay / emailed link) or in_person (card on the counter reader); NULL for cash, check, money order.';
UPDATE payments SET payment_channel = 'online'
 WHERE stripe_payment_intent_id IS NOT NULL AND payment_channel IS NULL;
