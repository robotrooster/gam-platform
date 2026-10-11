-- 10/4 (decisions #38, fix round 2): a card refund Stripe later sends BACK is
-- reversed on the day it came back — the day it went out is never rewritten.
--
-- Before: when Stripe reported a sent early check-out refund failed (a card
-- closed since, a bank that sent it back), the refund part went back to
-- 'failed' with refunded_at cleared and the register sale's card refund row
-- was DELETED. That rewrote the original refund day after the fact — that
-- day's income, its end-of-day card refunds, and the booking-site deposit /
-- lease refund lines all changed for a period already closed.
--
-- Now the record stays and a reversing entry is dated on the failure day:
--   stay_refund_parts.reversed_at  the part went out (status stays 'refunded',
--                                  refunded_at stays its own day) and came
--                                  back on this instant. A NEW part
--                                  (replaces_part_id, the next migration)
--                                  carries the money still owed to the guest
--                                  for Try again.
--   pos_refunds.reversed_at        the sale's card refund row stays; it no
--                                  longer counts toward what the sale has
--                                  refunded, and income / the close add it
--                                  back on this day.
--
-- Expand-only: two new nullable columns and two CHECKs every existing row
-- passes (no row is reversed yet). No backfill needed.
ALTER TABLE stay_refund_parts ADD COLUMN IF NOT EXISTS reversed_at timestamptz;
ALTER TABLE stay_refund_parts DROP CONSTRAINT IF EXISTS stay_refund_parts_reversed_shape;
ALTER TABLE stay_refund_parts ADD CONSTRAINT stay_refund_parts_reversed_shape CHECK (
  reversed_at IS NULL OR (status = 'refunded' AND kind IN ('card', 'bank') AND reversed_at >= refunded_at));

ALTER TABLE pos_refunds ADD COLUMN IF NOT EXISTS reversed_at timestamptz;
ALTER TABLE pos_refunds DROP CONSTRAINT IF EXISTS pos_refunds_reversed_shape;
ALTER TABLE pos_refunds ADD CONSTRAINT pos_refunds_reversed_shape CHECK (
  reversed_at IS NULL OR (refund_method = 'card' AND reversed_at >= created_at));

COMMENT ON COLUMN stay_refund_parts.reversed_at IS '10/4 fix round 2: Stripe sent this refund back at this instant. The part keeps its own refund day; income adds it back on this day; its replacement part (replaces_part_id) carries what is still owed to the guest.';
COMMENT ON COLUMN pos_refunds.reversed_at IS '10/4 fix round 2: this card refund came back at this instant. It stays on its own day and is added back on this one; it no longer counts toward what the sale has refunded.';
