-- 10/3 (decisions #13, Nic): "There should never be duplicate payments in the
-- first place. And if there are, do NOT automatically refund. Landlord needs
-- notification before refunding."
--
-- A register pay link's card payment that does not fit — the link already
-- paid (at the desk, or in another tab), a page paid at an amount the link no
-- longer asks (changed after the payer opened it), more than the link's
-- reservation still owed when it landed, or part of a long stay's deposit
-- (paid whole, decisions #15) — used to be rolled back and recorded
-- as NOTHING, with a notice asking GAM support to refund it. The money sat on
-- GAM's Stripe balance with no row anywhere saying whose it was.
--
-- Now it is RECORDED here, keyed on its PaymentIntent, so no dollar is lost:
-- GAM holds it, it is not a register sale and it is in nobody's payouts (no
-- held_payout_items row). The account owner is notified with the amount and a
-- one-click "Refund this payment" (POST /api/pos/held-payments/:id/refund —
-- the account owner only), which refunds the PaymentIntent through Stripe and
-- marks the row refunded. Nothing here ever refunds on its own. Stripe keeps
-- its processing fee on a refunded payment (stripe_fee_kept): the landlord's
-- loss (decisions #22), never GAM's.
--
-- Expand-only: a new table; no existing column or row changes. No backfill
-- needed (before this, such payments were not written anywhere). Kept forever
-- (GAM never erases); the cascades only matter when a parent row is deleted,
-- which production never does (they keep test cleanup simple).
CREATE TABLE IF NOT EXISTS pos_held_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  property_id uuid REFERENCES properties(id) ON DELETE CASCADE,
  pay_link_id uuid REFERENCES pos_pay_links(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES unit_bookings(id) ON DELETE SET NULL,
  stripe_payment_intent_id text NOT NULL,
  reason text NOT NULL,
  -- What the payer paid on it (card fee included) — what a refund sends back.
  amount numeric(10,2) NOT NULL,
  payer_name text,
  note text,
  status text NOT NULL DEFAULT 'held',
  stripe_refund_id text,
  refunded_at timestamptz,
  refunded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  -- 10/3 (decisions #22, Nic): Stripe's processing fee on this payment, which
  -- Stripe KEEPS when the payment is refunded. It is the landlord's loss,
  -- never GAM's: taken from their next payout as its own line. Read from
  -- Stripe when the owner is asked to confirm the refund (the button says the
  -- figure) and recorded again when the refund goes through. NULL until
  -- Stripe has said.
  stripe_fee_kept numeric(10,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- deposit_part: part of a long stay's deposit, which is paid whole (decisions #15).
  CONSTRAINT pos_held_payments_reason_check CHECK (reason IN ('paid_twice', 'wrong_amount', 'over_owed', 'deposit_part')),
  CONSTRAINT pos_held_payments_status_check CHECK (status IN ('held', 'refunded')),
  CONSTRAINT pos_held_payments_amount_check CHECK (amount > 0),
  CONSTRAINT pos_held_payments_refund_shape CHECK ((status = 'refunded') = (refunded_at IS NOT NULL)),
  CONSTRAINT pos_held_payments_fee_kept_check CHECK (stripe_fee_kept IS NULL OR (stripe_fee_kept >= 0 AND stripe_fee_kept <= amount))
);

-- One held row per payment: Stripe re-delivers webhooks.
CREATE UNIQUE INDEX IF NOT EXISTS pos_held_payments_intent_uniq ON pos_held_payments (stripe_payment_intent_id);
-- The owner's "still held" list.
CREATE INDEX IF NOT EXISTS pos_held_payments_held_idx ON pos_held_payments (landlord_id, created_at) WHERE status = 'held';

COMMENT ON TABLE pos_held_payments IS '10/3 (decisions #13): a pay-link card payment that did not fit (paid twice, an old amount, more than its reservation owed) — held by GAM, not a sale, in no payouts, refunded only when the account owner presses Refund this payment.';
