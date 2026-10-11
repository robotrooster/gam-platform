-- 10/4 (decisions #47a, Nic, FINAL): "land it on a to do list if original
-- payment cant complete. especially if theres a split such as landlord keeping
-- half. we need to verify both parts of that flow."
--
-- WHEN A LANDLORD FINALIZES A MOVE-OUT, THE PART OF THE DEPOSIT REFUND GAM
-- HOLDS (deposit_returns.refund_from_gam) IS SENT AUTOMATICALLY, back the way
-- the deposit was paid: a card to that same card, a bank payment to that same
-- bank. It goes through the SAME refund parts an early check-out and the
-- paid-ahead money screen use (stay_refund_parts, services/earlyCheckOut:
-- planRefund, the card/bank runner, Try again, "Give it back in cash instead",
-- the refund.updated webhook) — one part per original deposit payment, most
-- recent first — so retries, failures and Stripe's late answers work the same
-- way. A part the original payment cannot take (too old for the processor, a
-- closed card, no Stripe payment behind it — e.g. deposit interest — or a
-- refund that failed for good) stays on the owner's to-do list in plain words
-- until it is sent or given back in cash at the office (GAM then pays the
-- landlord what it held for it). It never silently disappears and never stays
-- GAM's money.
--
-- The part the LANDLORD holds (refund_from_landlord) is theirs to hand back;
-- the move-out page offers "Mark handed back" with the day, so it shows done.
--
-- → stay_refund_parts.deposit_return_id: a third parent next to an early
--   check-out decision and a paid-ahead choice (exactly one of the three).
-- → stay_refund_parts.deposit_payment_id: the deposit payment (payments.id,
--   type 'deposit') the part goes back to. A part with no payment behind it
--   (deposit interest, a deposit record raised without a Stripe payment) is a
--   'cash' part on the move-out alone, so the source rule allows a deposit
--   part with no source row.
-- → the replacement trigger (a part Stripe sent back, a card part given back
--   in cash instead) now copies the deposit columns from the part it replaces,
--   as it already copies the paid-ahead choice.
-- → deposit_returns.landlord_part_handed_back_on / _by / _at: "Mark handed
--   back" for the landlord's own part (NULL = not marked yet).
--
-- Expand-only: nullable columns; the two CHECKs are WIDENED (every existing
-- row still satisfies them: deposit_return_id is NULL on all of them). No
-- backfill needed — production has 0 deposit returns. Safe drop: the columns
-- and the index (put the two CHECKs and the trigger back as in
-- 20261004460000_paid_ahead_choices.sql).

ALTER TABLE stay_refund_parts ADD COLUMN IF NOT EXISTS deposit_return_id uuid
  REFERENCES deposit_returns(id) ON DELETE RESTRICT;
ALTER TABLE stay_refund_parts ADD COLUMN IF NOT EXISTS deposit_payment_id uuid
  REFERENCES payments(id) ON DELETE RESTRICT;

ALTER TABLE stay_refund_parts DROP CONSTRAINT IF EXISTS stay_refund_parts_one_parent;
ALTER TABLE stay_refund_parts ADD CONSTRAINT stay_refund_parts_one_parent CHECK (
  num_nonnulls(decision_id, paid_ahead_choice_id, deposit_return_id) = 1);

ALTER TABLE stay_refund_parts DROP CONSTRAINT IF EXISTS stay_refund_parts_source_check;
ALTER TABLE stay_refund_parts ADD CONSTRAINT stay_refund_parts_source_check CHECK (
  num_nonnulls(stay_payment_id, remittance_id, prepaid_credit_id, deposit_payment_id) >= 1
  OR deposit_return_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_stay_refund_parts_deposit_return
  ON stay_refund_parts (deposit_return_id) WHERE deposit_return_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stay_refund_parts_deposit_payment
  ON stay_refund_parts (deposit_payment_id) WHERE deposit_payment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION stay_refund_parts_replacement_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT rp.paid_ahead_choice_id, rp.deposit_return_id, rp.deposit_payment_id
    INTO NEW.paid_ahead_choice_id, NEW.deposit_return_id, NEW.deposit_payment_id
    FROM stay_refund_parts rp WHERE rp.id = NEW.replaces_part_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_stay_refund_parts_replacement_parent ON stay_refund_parts;
CREATE TRIGGER trg_stay_refund_parts_replacement_parent BEFORE INSERT ON stay_refund_parts
  FOR EACH ROW WHEN (NEW.replaces_part_id IS NOT NULL AND NEW.decision_id IS NULL
                     AND NEW.paid_ahead_choice_id IS NULL AND NEW.deposit_return_id IS NULL)
  EXECUTE FUNCTION stay_refund_parts_replacement_parent();

COMMENT ON COLUMN stay_refund_parts.deposit_return_id IS
  '10/4 (decisions #47a): a refund part of a finalized move-out — the part of the deposit refund GAM holds, sent back the way the deposit was paid (or given back in cash at the office when that payment cannot take it). booking_id is NULL.';
COMMENT ON COLUMN stay_refund_parts.deposit_payment_id IS
  '10/4 (decisions #47a): the deposit payment (payments.id, type deposit) a move-out refund part goes back to. NULL on a cash part with no Stripe payment behind it (deposit interest, a record raised without one).';

ALTER TABLE deposit_returns ADD COLUMN IF NOT EXISTS landlord_part_handed_back_on date;
ALTER TABLE deposit_returns ADD COLUMN IF NOT EXISTS landlord_part_handed_back_by uuid REFERENCES users(id);
ALTER TABLE deposit_returns ADD COLUMN IF NOT EXISTS landlord_part_handed_back_at timestamptz;
ALTER TABLE deposit_returns DROP CONSTRAINT IF EXISTS deposit_returns_handed_back_shape;
ALTER TABLE deposit_returns ADD CONSTRAINT deposit_returns_handed_back_shape CHECK (
  (landlord_part_handed_back_on IS NULL) = (landlord_part_handed_back_at IS NULL));

COMMENT ON COLUMN deposit_returns.landlord_part_handed_back_on IS
  '10/4 (decisions #47a): the day the landlord handed back their own part of the refund (refund_from_landlord), as they marked it on the move-out page ("Mark handed back"). NULL: not marked yet.';
