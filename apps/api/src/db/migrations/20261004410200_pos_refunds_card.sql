-- 10/4 (decisions #37.B, #38 Q4/Q10): a register sale's money can go back to
-- the CARD that paid it.
--
-- S339 limited register refunds to cash, a check or the charge account ("GAM
-- does not process refunds back to a card"), and dropped 'card' from this
-- CHECK — while the end-of-day close (services/posEod) still adds up 'card'
-- refunds and the register's refund toast still handles one. Nic (#37.B): a
-- refund goes back ONLY the way it was paid — a card is refunded to that same
-- card. An early check-out's refund of a stay paid by card (at the counter, a
-- card on file, a pay link) now goes back through Stripe, and its register
-- refund row says so.
--
-- New columns, all nullable or defaulted:
--   stripe_refund_id     the Stripe refund (a card refund only);
--   card_fee_refunded    the card fee the guest paid on the refunded part,
--                        given back with it (#38 Q4) — in `amount`, but never
--                        part of the sale's income (services/incomeBasis
--                        takes it out before the pre-tax share);
--   stay_refund_part_id  the early check-out refund part this row records.
--
-- Expand-only: the CHECK gains 'card' (every existing row still passes), and
-- three new columns. No backfill needed (no card refund was ever recorded).
ALTER TABLE pos_refunds DROP CONSTRAINT IF EXISTS pos_refunds_method_check;
ALTER TABLE pos_refunds ADD CONSTRAINT pos_refunds_method_check
  CHECK (refund_method IN ('cash', 'check', 'charge', 'card'));

ALTER TABLE pos_refunds ADD COLUMN IF NOT EXISTS stripe_refund_id text;
ALTER TABLE pos_refunds ADD COLUMN IF NOT EXISTS card_fee_refunded numeric(10,2) NOT NULL DEFAULT 0;
ALTER TABLE pos_refunds ADD COLUMN IF NOT EXISTS stay_refund_part_id uuid
  REFERENCES stay_refund_parts(id) ON DELETE SET NULL;

ALTER TABLE pos_refunds DROP CONSTRAINT IF EXISTS pos_refunds_card_shape;
ALTER TABLE pos_refunds ADD CONSTRAINT pos_refunds_card_shape
  CHECK ((refund_method = 'card') = (stripe_refund_id IS NOT NULL)
         AND card_fee_refunded >= 0 AND card_fee_refunded <= amount);

CREATE UNIQUE INDEX IF NOT EXISTS pos_refunds_stripe_refund_uniq ON pos_refunds (stripe_refund_id)
  WHERE stripe_refund_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pos_refunds_stay_part_uniq ON pos_refunds (stay_refund_part_id)
  WHERE stay_refund_part_id IS NOT NULL;
