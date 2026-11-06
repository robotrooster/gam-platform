-- 10/29 (Nic, final after saying it four times): a left-owing debt settles at
-- 80% of the original and the money divides THREE ways, not one.
--
--   "20% wiped off the board... 50% to the old landlord... let's do 15 and 15.
--    We're providing the new landlord the tools to get the job done and the
--    information and the coordination. They're the ones taking the risk of
--    letting the new person in. I think that's worth even amounts."
--
-- On a $1,000 balance: $500 to the landlord who was left without it, $150 to
-- GAM, $150 to the landlord doing the collecting, $200 nobody ever pays.
--
-- Until now the whole collected installment went to the landlord owed, and the
-- arrangement was opened for the FULL balance rather than the settled 80% — so
-- the resident was billed 25% more than anybody is owed and neither GAM nor the
-- collecting landlord earned their share.
--
-- Two allowed-value sets widen to carry it. Both mirror a list in
-- packages/shared (CLAUDE.md: one definition per set) and both are additive —
-- no existing row changes meaning.
--
--   held_payout_items.source_type   + 'left_owing_share'
--       The collecting landlord's own cut coming BACK to them. The whole
--       collection is netted off them first and their share returns as its own
--       line, so each movement is readable on its own.
--
--   platform_revenue_ledger.type    + 'left_owing_share'
--       GAM's 15%, booked per collection as it arrives. A part-paid
--       arrangement earns GAM only the part that was paid.
--
-- No backfill needed: nothing has ever been collected under an arrangement
-- (left_owing_collections is empty), so there is no history to re-split.

ALTER TABLE held_payout_items DROP CONSTRAINT IF EXISTS held_payout_items_source_type_check;
ALTER TABLE held_payout_items ADD CONSTRAINT held_payout_items_source_type_check
  CHECK (source_type = ANY (ARRAY[
    'pos_sale', 'booking_deposit', 'business_invoice_payment',
    'business_pos_sale', 'refund', 'dispute', 'platform_fee', 'prepaid_draw',
    'deposit_settlement',
    'left_owing_netted', 'left_owing_paid', 'left_owing_share'
  ]::text[]));

ALTER TABLE platform_revenue_ledger DROP CONSTRAINT IF EXISTS platform_revenue_ledger_type_check;
ALTER TABLE platform_revenue_ledger ADD CONSTRAINT platform_revenue_ledger_type_check
  CHECK (type = ANY (ARRAY[
    'banking_spread', 'manual_withdrawal_fee', 'placement_fee_share',
    'platform_fee_subscription', 'screening_margin', 'adjustment',
    'flexpay_subscription', 'device_markup',
    'flexdeposit_fee', 'flexdeposit_move_fee',
    'flexdeposit_shortfall', 'flexdeposit_recovery',
    'left_owing_share'
  ]::text[]));
