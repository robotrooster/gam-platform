-- 10/4 (decisions #37.B, #38): what an early check-out did with the money, and
-- each part of any refund it sent back.
--
-- Nic: a guest who leaves before the booked day is asked ONE money question
-- (shared EARLY_CHECKOUT_CHOICES):
--   - still owes for the stay → "Keep the price as booked" / "Charge only the
--     nights stayed" (never more than the booked price, #38 Q7);
--   - paid more than the nights stayed are worth → "No refund (keep the price
--     as booked)" / "Refund the unused nights" / "Refund a different amount".
-- A refund re-prices nothing (#38 Q2) and goes back only the way it was paid
-- (#37.B, #38 Q3/Q10). Staff without "Issue refunds" can still check an
-- overpaid guest out: the question then WAITS on the stay ('pending') for
-- someone who can refund, and the owner gets a to-do (#38 Q5). Once a refund
-- has gone out the check-out cannot be undone (#38 Q11).
--
-- stay_checkout_decisions: one live question (pending or decided) per stay at
-- a time. 'undone' when the check-out it belonged to was put back (a new
-- check-out asks again). booked_price / stayed_worth / paid are the figures the
-- question was asked on (B, S, P); price_after the stay's price once decided
-- (S for "Charge only the nights stayed", otherwise B); refund_total what was
-- sent back. stamped_paid: the decision stamped the stay paid in full, so an
-- undo can take that stamp off again. idempotency_key: the screen makes one
-- when it opens, so a double click (or two staff) decides once.
--
-- stay_refund_parts: one row per payment a refund went back to. amount is what
-- the GUEST gets back on it (their share of the stay plus the card fee they
-- paid on that share, #38 Q4), card_fee_back the fee part of it, payout_drop
-- what the landlord's next payout drops by for it (a card or bank refund comes
-- out of GAM's balance, so the payout nets it — the landlord bears Stripe's
-- kept fee, GAM absorbs nothing, #13/#22/#38 Q4), lodging_tax_share the lodging
-- tax inside the stay share. status: a card or bank part is 'pending' until
-- Stripe answers ('refunded', or 'failed' with the words why; Try again re-runs
-- it, attempts counts the tries); cash, a check or a money order is
-- 'handed_back' at the desk;
-- a charge account is 'refunded' onto the account; paid-ahead credit stays
-- 'credited'. Stripe's own refund id is unique, so a part is never paid twice.
--
-- Expand-only: two new tables. No backfill needed (nothing like this was
-- recorded before). Kept forever; the cascades only matter when a parent row is
-- deleted, which production never does.
CREATE TABLE IF NOT EXISTS stay_checkout_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES unit_bookings(id) ON DELETE CASCADE,
  landlord_id uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  lease_id uuid REFERENCES leases(id) ON DELETE SET NULL,
  left_on date NOT NULL,
  question text NOT NULL,
  choice text,
  status text NOT NULL DEFAULT 'pending',
  booked_price numeric(10,2) NOT NULL,
  stayed_worth numeric(10,2) NOT NULL,
  paid numeric(10,2) NOT NULL,
  price_after numeric(10,2),
  refund_total numeric(10,2) NOT NULL DEFAULT 0,
  stamped_paid boolean NOT NULL DEFAULT false,
  idempotency_key text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  undone_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stay_checkout_decisions_question_check CHECK (question IN ('owes', 'overpaid')),
  CONSTRAINT stay_checkout_decisions_choice_check CHECK (
    choice IS NULL OR choice IN ('keep_price', 'nights_only', 'no_refund', 'refund_unused', 'refund_other')),
  CONSTRAINT stay_checkout_decisions_status_check CHECK (status IN ('pending', 'decided', 'undone')),
  CONSTRAINT stay_checkout_decisions_decided_shape CHECK (
    (status = 'pending' AND choice IS NULL AND decided_at IS NULL)
    OR (status = 'decided' AND choice IS NOT NULL AND decided_at IS NOT NULL)
    OR (status = 'undone' AND undone_at IS NOT NULL)),
  CONSTRAINT stay_checkout_decisions_money_check CHECK (
    booked_price >= 0 AND stayed_worth >= 0 AND paid >= 0 AND refund_total >= 0 AND refund_total <= paid)
);

-- One live money question per stay.
CREATE UNIQUE INDEX IF NOT EXISTS stay_checkout_decisions_live_uniq ON stay_checkout_decisions (booking_id)
  WHERE status IN ('pending', 'decided');
CREATE UNIQUE INDEX IF NOT EXISTS stay_checkout_decisions_idem_uniq ON stay_checkout_decisions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- The owner's to-do: questions still waiting.
CREATE INDEX IF NOT EXISTS stay_checkout_decisions_pending_idx ON stay_checkout_decisions (landlord_id, created_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS stay_refund_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id uuid NOT NULL REFERENCES stay_checkout_decisions(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES unit_bookings(id) ON DELETE CASCADE,
  landlord_id uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  -- The order the refund went back in: 1 = the most recent payment.
  seq integer NOT NULL,
  kind text NOT NULL,
  -- Which payment it goes back to: a payment toward the stay, a rent payment
  -- (tenant_remittances), or credit that paid the rent.
  stay_payment_id uuid REFERENCES stay_payments(id) ON DELETE CASCADE,
  -- RESTRICT: the payment a refund went back to is never erased from under it.
  remittance_id uuid REFERENCES tenant_remittances(id) ON DELETE RESTRICT,
  prepaid_credit_id uuid REFERENCES lease_prepaid_credits(id) ON DELETE RESTRICT,
  pos_transaction_id uuid REFERENCES pos_transactions(id) ON DELETE SET NULL,
  stripe_payment_intent_id text,
  -- The payment's share being given back (before any card fee).
  toward_amount numeric(10,2) NOT NULL,
  card_fee_back numeric(10,2) NOT NULL DEFAULT 0,
  amount numeric(10,2) NOT NULL,
  payout_drop numeric(10,2) NOT NULL DEFAULT 0,
  lodging_tax_share numeric(10,2) NOT NULL DEFAULT 0,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  stripe_refund_id text,
  pos_refund_id uuid,
  failure text,
  refunded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stay_refund_parts_kind_check CHECK (kind IN ('card', 'bank', 'cash', 'check', 'money_order', 'charge', 'credit')),
  CONSTRAINT stay_refund_parts_status_check CHECK (status IN ('pending', 'refunded', 'handed_back', 'credited', 'failed')),
  CONSTRAINT stay_refund_parts_amount_check CHECK (
    toward_amount > 0 AND card_fee_back >= 0 AND amount = toward_amount + card_fee_back
    AND payout_drop >= 0 AND lodging_tax_share >= 0),
  CONSTRAINT stay_refund_parts_source_check CHECK (num_nonnulls(stay_payment_id, remittance_id, prepaid_credit_id) >= 1),
  -- A card or bank part goes back through Stripe, on the payment's own intent.
  CONSTRAINT stay_refund_parts_stripe_shape CHECK (
    kind NOT IN ('card', 'bank') OR stripe_payment_intent_id IS NOT NULL),
  -- refunded_at is the day the money went back (the refund's own day, for the
  -- reports); a part still waiting on Stripe, or one that failed, has none.
  CONSTRAINT stay_refund_parts_done_shape CHECK (
    (status IN ('refunded', 'handed_back', 'credited')) = (refunded_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS stay_refund_parts_stripe_refund_uniq ON stay_refund_parts (stripe_refund_id)
  WHERE stripe_refund_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stay_refund_parts_decision_idx ON stay_refund_parts (decision_id, seq);
CREATE INDEX IF NOT EXISTS stay_refund_parts_stay_payment_idx ON stay_refund_parts (stay_payment_id)
  WHERE stay_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stay_refund_parts_remittance_idx ON stay_refund_parts (remittance_id)
  WHERE remittance_id IS NOT NULL;

COMMENT ON TABLE stay_checkout_decisions IS '10/4 (decisions #37.B, #38): the money question an early check-out asked (still owes / paid more than the nights stayed are worth), what was chosen and by whom. One live (pending or decided) per stay.';
COMMENT ON TABLE stay_refund_parts IS '10/4 (decisions #37.B, #38): each payment an early check-out refund went back to — the way it was paid, most recent first — with what the guest got back (card fee included, #38 Q4) and what the landlord''s payout dropped by.';
