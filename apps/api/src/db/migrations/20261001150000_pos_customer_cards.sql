-- S654 (Nic): "automatically build a customer base… read the name on their
-- card, add them as a customer… ask them if they want to save their card."
--
-- The CARD is the customer: Stripe gives every physical card a stable
-- fingerprint, so the same card next time is the same person and their
-- purchase history. The printed cardholder name becomes the record's name;
-- staff fix it or add an email/phone at the register later. A second card from
-- the same person starts a second record (Nic: leave them separate for now).
-- A card the customer chose to keep (Yes on the reader's own screen) carries
-- the reusable PaymentMethod Stripe generated from that same tap.
--
-- No backfill: existing customers have no cards on file here. Safe to drop.
CREATE TABLE IF NOT EXISTS pos_customer_cards (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id              uuid NOT NULL REFERENCES landlords(id),
  pos_customer_id          uuid NOT NULL REFERENCES pos_customers(id),
  fingerprint              text NOT NULL,
  brand                    text,
  last4                    text,
  cardholder_name          text,
  stripe_payment_method_id text,
  saved_at                 timestamptz,
  first_seen_at            timestamptz NOT NULL DEFAULT NOW(),
  last_seen_at             timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (landlord_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS pos_customer_cards_customer_idx ON pos_customer_cards (pos_customer_id);

-- A customer made from a card has no email until they give one for a receipt.
ALTER TABLE pos_customers ALTER COLUMN email DROP NOT NULL;
ALTER TABLE pos_customers ADD COLUMN IF NOT EXISTS created_from text NOT NULL DEFAULT 'manual';
ALTER TABLE pos_customers DROP CONSTRAINT IF EXISTS pos_customers_created_from_check;
ALTER TABLE pos_customers ADD CONSTRAINT pos_customers_created_from_check CHECK (created_from IN ('manual', 'card_reader'));
