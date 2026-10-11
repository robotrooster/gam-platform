-- 10/4 (decisions #37.B, #38): every payment toward a stay, one row each, so an
-- early check-out can say exactly what the guest paid and give it back the way
-- it was paid.
--
-- Until now what a reservation had been paid was read from FLAGS on the
-- booking: balance_paid_at stamped means "the whole price", else deposit_amount
-- (a running total that settleLinkBooking overwrites). Neither says HOW the
-- money came in or WHICH payment it was, and a sale's share for the stay (a
-- register sale can carry propane too) was not stored anywhere. Nic (#37.B,
-- #38 Q3/Q4/Q10): a refund goes back ONLY the way it was paid — a card to that
-- same card, cash handed back at the desk, a charge account back onto the
-- account — most recent payment first, and the guest gets back the card fee
-- they paid on the refunded part. That needs the payments themselves.
--
-- One row per payment toward a stay, written where the money lands:
--   - 'site_deposit': the deposit paid on the public booking page
--     (services/propertyBooking confirmBookingDeposit) — its PaymentIntent;
--   - 'pos_sale': a register sale that paid toward the stay — the counter's
--     reservation ticket, a stay rung straight at the counter, a pay link paid
--     at the counter or online (settleLinkBooking).
-- toward_stay is what that payment paid toward the stay (its share of the sale,
-- tax inside, before any card fee). card_fee is the card fee the GUEST paid on
-- top for that share; landlord_card_fee the card fee the LANDLORD covered on it
-- (taken from their payout) — together what the card fee on that share was.
--
-- Money GAM holds aside (pos_held_payments: paid twice, the wrong amount, more
-- than owed) is never a payment toward the stay and never has a row here.
--
-- Expand-only: a new table. No backfill needed: production has one booking,
-- cancelled and unpaid (checked 10/3), and the early check-out reads a booking
-- paid before this table as paid but not itemized (it cannot be refunded here).
-- Kept forever; the cascades only matter when a parent row is deleted, which
-- production never does (they keep test cleanup simple).
CREATE TABLE IF NOT EXISTS stay_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES unit_bookings(id) ON DELETE CASCADE,
  landlord_id uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  kind text NOT NULL,
  pos_transaction_id uuid REFERENCES pos_transactions(id) ON DELETE CASCADE,
  stripe_payment_intent_id text,
  -- The way it was paid (pos_transactions.payment_method; a site deposit is a card).
  method text NOT NULL,
  toward_stay numeric(10,2) NOT NULL,
  card_fee numeric(10,2) NOT NULL DEFAULT 0,
  landlord_card_fee numeric(10,2) NOT NULL DEFAULT 0,
  paid_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stay_payments_kind_check CHECK (kind IN ('site_deposit', 'pos_sale')),
  CONSTRAINT stay_payments_method_check CHECK (method IN ('card', 'card_on_file', 'cash', 'check', 'charge')),
  CONSTRAINT stay_payments_toward_check CHECK (toward_stay > 0),
  CONSTRAINT stay_payments_fees_check CHECK (card_fee >= 0 AND landlord_card_fee >= 0),
  -- A sale names its sale; a site deposit is a card paid on GAM's account.
  CONSTRAINT stay_payments_source_shape CHECK (
    (kind = 'pos_sale' AND pos_transaction_id IS NOT NULL)
    OR (kind = 'site_deposit' AND pos_transaction_id IS NULL AND stripe_payment_intent_id IS NOT NULL AND method = 'card')),
  -- Money that went through a card was charged on GAM's account (it has an intent).
  CONSTRAINT stay_payments_card_has_intent CHECK (
    method NOT IN ('card', 'card_on_file') OR stripe_payment_intent_id IS NOT NULL)
);

-- One row per payment: the counter and a link paid at the counter both settle
-- the same sale, and Stripe re-delivers webhooks.
CREATE UNIQUE INDEX IF NOT EXISTS stay_payments_sale_uniq ON stay_payments (booking_id, pos_transaction_id)
  WHERE pos_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stay_payments_site_deposit_uniq ON stay_payments (booking_id)
  WHERE kind = 'site_deposit';
CREATE INDEX IF NOT EXISTS stay_payments_booking_idx ON stay_payments (booking_id, paid_at);

COMMENT ON TABLE stay_payments IS '10/4 (decisions #37.B, #38): one row per payment toward a stay — how it was paid, how much of it was for the stay, and the card fee on that share. An early check-out reads what the guest paid only from here and refunds each payment back the way it came, most recent first.';
