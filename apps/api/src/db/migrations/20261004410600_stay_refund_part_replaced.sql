-- 10/4 (decisions #38, fix round 2): a card or bank refund that did not go out
-- can be given back in CASH instead — recorded, so it is never sent twice.
--
-- A failed card part used to say "press Try again, or give it back another
-- way", with no way to record "given back another way": the to-do and Try
-- again never went away, and the register could refund the same money in cash
-- while a later Try again still sent it to the card (a $240 decision paid out
-- $480). Now someone with "Issue refunds" presses "Give it back in cash
-- instead" on the failed part: that part becomes 'replaced' (it never went
-- out) and a new 'cash' part, handed back at the desk, takes its place
-- (replaces_part_id). The same column links the new part Stripe's sent-back
-- refund leaves for Try again (previous migration, reversed_at).
--
-- Expand-only: the status CHECK gains 'replaced' (every existing row still
-- passes), one new nullable column, one unique partial index (a part is
-- replaced at most once). No backfill needed.
ALTER TABLE stay_refund_parts DROP CONSTRAINT IF EXISTS stay_refund_parts_status_check;
ALTER TABLE stay_refund_parts ADD CONSTRAINT stay_refund_parts_status_check
  CHECK (status IN ('pending', 'refunded', 'handed_back', 'credited', 'failed', 'replaced'));

ALTER TABLE stay_refund_parts ADD COLUMN IF NOT EXISTS replaces_part_id uuid
  REFERENCES stay_refund_parts(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS stay_refund_parts_replaces_uniq ON stay_refund_parts (replaces_part_id)
  WHERE replaces_part_id IS NOT NULL;

COMMENT ON COLUMN stay_refund_parts.replaces_part_id IS '10/4 fix round 2: the part this one takes the place of — a card refund Stripe sent back (reversed_at), or a failed card part given back in cash instead (status replaced).';
