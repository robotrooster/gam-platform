-- S648 (Nic): "All money pools to Stripe the same way that people pay rent and
-- then that batches and pays out to the landlord on a cycle... the propane sales
-- throughout the week will go in a batch payment... All that money needs to flow
-- directly to GAM first and then be dispersed that way. We can take our cut."
--
-- Register card sales (counter reader and emailed/QR pay links) are now charged
-- on GAM's platform account. What the landlord is owed for a sale — the total
-- less the card fee, which is GAM's — waits here until the weekly payout batch
-- (services/landlordPassthrough.ts) claims it, exactly like rent's owner share.
--
--   payout_owed      — dollars GAM owes the landlord for this sale (0 for cash
--                      and store-charge sales: the landlord already has that).
--   payout_intent_id — the payout batch that carried it. NULL + owed > 0 = held.
--
-- No backfill needed: no register card sale has ever been recorded (0 rows with
-- a PaymentIntent at the time of writing).
ALTER TABLE pos_transactions
  ADD COLUMN payout_owed numeric(10,2) NOT NULL DEFAULT 0 CHECK (payout_owed >= 0),
  ADD COLUMN payout_intent_id uuid REFERENCES platform_transfer_intents(id);

CREATE INDEX idx_pos_transactions_payout_held
  ON pos_transactions (landlord_id)
  WHERE payout_owed > 0 AND payout_intent_id IS NULL;

-- A card dispute on a register sale is the landlord's to bear, the same as a
-- rent chargeback: it becomes a receivable that the next payout nets (or a bank
-- pull if nothing is coming). The reversal table was rent-only (payment_id NOT
-- NULL); a reversal now points at exactly one of a payment or a register sale.
ALTER TABLE payment_reversals
  ALTER COLUMN payment_id DROP NOT NULL,
  ADD COLUMN pos_transaction_id uuid REFERENCES pos_transactions(id),
  ADD CONSTRAINT payment_reversals_one_source CHECK ((payment_id IS NULL) <> (pos_transaction_id IS NULL));

CREATE UNIQUE INDEX payment_reversals_pos_event_uq
  ON payment_reversals (pos_transaction_id, stripe_object_id)
  WHERE pos_transaction_id IS NOT NULL;

-- Readers for landlord registers now pair to GAM's platform account inside a
-- per-property Terminal Location (Stripe requires a location on the platform).
ALTER TABLE properties ADD COLUMN IF NOT EXISTS stripe_terminal_location_id text;
