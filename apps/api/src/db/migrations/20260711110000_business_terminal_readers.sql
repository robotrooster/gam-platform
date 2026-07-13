-- S536 (Nic): businesses run card-present sales through their own
-- Stripe Terminal reader — "swiping the card or tap completes the
-- transaction; double workflow is not the way to operate." Mirrors
-- pos_terminal_readers (landlord/property pairing) at business scope.
-- The reader lives on the BUSINESS's Connect account (direct charges:
-- the business pays Stripe's processing cost; GAM's markup rides as
-- application_fee_amount — GAM can never lose money on a sale).
-- No backfill needed (new table + nullable column).
CREATE TABLE business_terminal_readers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id),
  stripe_reader_id TEXT NOT NULL,
  nickname         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  registered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_business_terminal_readers_business ON business_terminal_readers(business_id) WHERE status = 'active';

-- Terminal-paid sales record their PI for verification + refunds.
ALTER TABLE business_pos_transactions ADD COLUMN stripe_payment_intent_id TEXT;
CREATE UNIQUE INDEX idx_business_pos_tx_pi ON business_pos_transactions(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
