-- 10/23 (Nic) — A CHECK CAN BE TAKEN AT THE REGISTER, AND A PARK CAN SAY NO.
--
--   "On the point of sale system, we need to add a button to record check
--    payments. That also needs to be turned on or off if a property chooses to
--    accept checks. A lot of places don't accept them. For some reason, you can
--    record an invoice with a check number and record the payment, but you
--    can't do it on the point of sale system."
--
-- He is exactly right about the asymmetry. A resident's invoice has taken a
-- check since S655 — POST /api/payments/:id/record-manual with method 'check'
-- and the number in `reference` — while pos_transactions.payment_method allowed
-- only 'cash', 'card', 'card_on_file' and 'charge'. So the one place a check is
-- most likely to be handed over, the counter, was the one place that could not
-- write it down.
--
-- THE CHECK NUMBER IS PART OF THE RECORD, not a note. It is how a park finds
-- the payment again when the bank returns the check or the customer asks which
-- one paid for what, and `reference` is what the invoice side already calls it.
--
-- A CHECK IS FREE, like cash. S654 (Nic): "There's no fee. Paying cash or check
-- is free." Nothing here adds a fee, a fee-payer or a surcharge, and
-- serverCartTotals is left to treat 'check' the way it treats 'cash'.
--
-- THE PARK'S OWN ANSWER, defaulting to YES. Every property on GAM today takes
-- checks on invoices already, so a default of FALSE would silently stop
-- something that works. A park that does not take them turns it off, which is
-- the question Nic asked for.
--
-- No backfill: the column defaults, and the CHECK only widens.

ALTER TABLE pos_transactions DROP CONSTRAINT IF EXISTS pos_transactions_payment_method_check;
ALTER TABLE pos_transactions ADD CONSTRAINT pos_transactions_payment_method_check
  CHECK (payment_method IN ('cash', 'check', 'card', 'card_on_file', 'charge'));

ALTER TABLE pos_transactions ADD COLUMN IF NOT EXISTS payment_reference TEXT;

COMMENT ON COLUMN pos_transactions.payment_reference IS
  '10/23: the check number on a check sale — the same thing payments.reference holds on an invoice. NULL on every other tender.';

-- A reference belongs to a tender that has one. Cash has no number.
ALTER TABLE pos_transactions DROP CONSTRAINT IF EXISTS pos_transactions_reference_shape;
ALTER TABLE pos_transactions ADD CONSTRAINT pos_transactions_reference_shape
  CHECK (payment_reference IS NULL OR payment_method = 'check');

ALTER TABLE properties ADD COLUMN IF NOT EXISTS accepts_checks BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN properties.accepts_checks IS
  '10/23 (Nic): "that needs to be turned on or off if a property chooses to accept checks. A lot of places don''t accept them." Defaults TRUE because every property already takes a check on an invoice.';
