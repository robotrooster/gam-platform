-- S648 (Nic): "money all needs to flow through the platform. Every single
-- cent... so that it can be batched and paid out accordingly. We are gonna hold
-- all funds even if briefly." When a landlord or business isn't paid they want
-- to deal with GAM, not Stripe — a charge that pays them directly is one more
-- way for that to break.
--
-- ONE ledger of what GAM holds for someone, for every source that isn't rent
-- (rent keeps its owner-share ledger in user_balance_ledger):
--   + pos_sale                  landlord register card sale (total − card fee)
--   + booking_deposit           a guest's stay deposit (deposit, card fee is GAM's)
--   + business_invoice_payment  an invoice paid online (paid − GAM's cut)
--   + business_pos_sale         business register card sale (total − GAM's cut)
--   − refund                    money GAM sent back to a customer for them
--   − dispute                   a chargeback: disputed amount + Stripe's fee
--   − platform_fee              a GAM fee taken out of the payout
-- The weekly batch sums a payee's unbatched items (with rent, for landlords)
-- and pays the total in one transfer; a negative total carries to next week.
--
-- Replaces the register-only pos_transactions.payout_owed / payout_intent_id
-- and payment_reversals.pos_transaction_id added an hour earlier
-- (20260916200000). Both unused: 0 rows at the time of writing — verified.
CREATE TABLE held_payout_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id      uuid REFERENCES landlords(id),
  business_id      uuid REFERENCES businesses(id),
  source_type      text NOT NULL CHECK (source_type IN (
                     'pos_sale', 'booking_deposit', 'business_invoice_payment',
                     'business_pos_sale', 'refund', 'dispute', 'platform_fee')),
  -- the row or Stripe object the money came from; one item per source
  source_id        text NOT NULL,
  amount           numeric(12,2) NOT NULL CHECK (amount <> 0),
  description      text,
  payout_intent_id uuid REFERENCES platform_transfer_intents(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT held_payout_items_one_payee CHECK ((landlord_id IS NULL) <> (business_id IS NULL)),
  CONSTRAINT held_payout_items_one_per_source UNIQUE (source_type, source_id)
);
CREATE INDEX idx_held_payout_items_landlord_held ON held_payout_items (landlord_id) WHERE payout_intent_id IS NULL AND landlord_id IS NOT NULL;
CREATE INDEX idx_held_payout_items_business_held ON held_payout_items (business_id) WHERE payout_intent_id IS NULL AND business_id IS NOT NULL;

INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, payout_intent_id, created_at)
SELECT landlord_id, 'pos_sale', id::text, payout_owed, payout_intent_id, created_at
  FROM pos_transactions WHERE payout_owed > 0;

DROP INDEX IF EXISTS idx_pos_transactions_payout_held;
ALTER TABLE pos_transactions DROP COLUMN payout_owed, DROP COLUMN payout_intent_id;

DROP INDEX IF EXISTS payment_reversals_pos_event_uq;
ALTER TABLE payment_reversals DROP CONSTRAINT payment_reversals_one_source;
ALTER TABLE payment_reversals DROP COLUMN pos_transaction_id;
ALTER TABLE payment_reversals ALTER COLUMN payment_id SET NOT NULL;

-- The payout batch now pays businesses too: exactly one payee per batch.
ALTER TABLE platform_transfer_intents
  ALTER COLUMN landlord_id DROP NOT NULL,
  ALTER COLUMN landlord_user_id DROP NOT NULL,
  ADD COLUMN business_id uuid REFERENCES businesses(id),
  ADD CONSTRAINT platform_transfer_intents_one_payee CHECK ((landlord_id IS NULL) <> (business_id IS NULL));

COMMENT ON TABLE held_payout_items IS 'S648: what GAM holds for a landlord or business, outside rent. Positive = owed to them; negative = owed back. Batched weekly via platform_transfer_intents.';
