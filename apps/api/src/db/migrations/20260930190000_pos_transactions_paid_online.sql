-- S653 (Nic): "a point of sale at mountain view shows a card charge for
-- propane. well it isnt clickable but thats the only thing sold. we need to
-- flag the history different for pay links vs terminal reader."
--
-- Every card sale is recorded with payment_method='card', whether the customer
-- tapped the reader at the counter or paid an emailed link from home. Those
-- are different facts about how the money arrived (and there was no reader at
-- Mountain View when that "card" sale happened). This flag records the online
-- one; card without it is the reader. payment_method itself is untouched.
--
-- Backfill: a card sale tied to a pay link with a Stripe payment behind it was
-- paid online — the register could not yet settle a link by card when these
-- rows were written.
ALTER TABLE pos_transactions ADD COLUMN paid_online boolean NOT NULL DEFAULT false;
UPDATE pos_transactions SET paid_online = true
 WHERE payment_method = 'card' AND pay_link_id IS NOT NULL AND stripe_payment_intent_id IS NOT NULL;
COMMENT ON COLUMN pos_transactions.paid_online IS 'S653: the customer paid this themselves on an emailed pay link. A card sale without it was run on the reader at the counter.';
