-- 10/27 (Nic) — THE TWO SIDES OF A DEBT COLLECTED FOR ANOTHER OPERATOR.
--
-- The second door bills the resident's installment on the COLLECTING
-- landlord's invoice, because that is the invoice the resident gets. The
-- allocation engine therefore credits it to that landlord as an owner share,
-- exactly as it does for any other carried balance — and this money is not
-- theirs. It belongs to the landlord who was left owing.
--
-- Nic, 10/20, on what the collecting landlord is agreeing to:
--
--   "they can pay you and we'll collect the money from you. But if you click
--    on this and they don't pay, we're collecting that debt from you. You're
--    going to be paying that debt on that tenant's behalf. So only... Only
--    open it if you're ready to freaking rock and roll."
--
-- So the money moves between the two landlords inside the ordinary weekly
-- batch, as two held items — the mechanism S648 already built for every cent
-- GAM holds, netting positives and negatives in one payout:
--
--   left_owing_netted  NEGATIVE against the collecting landlord
--   left_owing_paid    POSITIVE  to the landlord owed
--
-- Two source types and not one because held_payout_items is unique per
-- (source_type, source_id) and both lines are about the same payment, so one
-- name could only ever write one of them.
--
-- NO BACKFILL NEEDED: a widened CHECK accepts rows it did not before and
-- rejects nothing it used to accept. No arrangement exists yet, so there is no
-- past collection to move.

ALTER TABLE public.held_payout_items
  DROP CONSTRAINT IF EXISTS held_payout_items_source_type_check;

ALTER TABLE public.held_payout_items
  ADD CONSTRAINT held_payout_items_source_type_check
  CHECK (source_type IN (
    'pos_sale', 'booking_deposit', 'business_invoice_payment',
    'business_pos_sale', 'refund', 'dispute', 'platform_fee', 'prepaid_draw',
    'deposit_settlement',
    'left_owing_netted', 'left_owing_paid'
  ));
