-- S652: the register gains a tender — the card the customer already gave us.
--
-- Nic, thinking about propane delivered off the park: "maybe if they save a
-- payment method on file as a point of sale customer, we can just auto charge
-- them on delivery and we don't even have to take the reader with us."
--
-- The card is already there. GAM has never spent a separate authorization to
-- store one: rent's own charge carries setup_future_usage, so the first payment
-- saves the card and everything after it can be taken without the person
-- present (S603 — Stripe bills per bank ASK, so "add a card, then pay later"
-- cost two asks to collect one rent). Tenants therefore arrive with a card on
-- file as a by-product of paying rent once, which is exactly Nic's point:
-- "the same button click does both."
--
-- WHY IT IS ITS OWN VALUE rather than being written down as 'card'. The money,
-- the fee and the payout are identical — it is a card, and it pays the same
-- 3.5% + $0.55 as any other card. What differs is that nobody was standing
-- there: it can fail for reasons a reader sale cannot (a bank demanding the
-- cardholder), and at end of day "which of these went through the reader" is a
-- question somebody will ask while counting a till. A row that cannot answer it
-- is a row that gets argued with.

ALTER TABLE pos_transactions DROP CONSTRAINT IF EXISTS pos_transactions_payment_method_check;
ALTER TABLE pos_transactions ADD CONSTRAINT pos_transactions_payment_method_check
  CHECK (payment_method = ANY (ARRAY['cash', 'card', 'card_on_file', 'charge']));
