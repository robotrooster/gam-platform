-- 10/27 (Nic) — THE INSTALLMENT RIDES THE RESIDENT'S RENT.
--
--   "The tenant will be charged in installments in addition to whatever rent
--    that new landlord has."
--
-- Each month's installment is an ordinary bill line — type 'carried_balance',
-- entry_description 'BALANCE', the same shape every other carried balance on
-- the platform already uses, so it inherits the invoice, the reminders and the
-- landlord's own late-fee rules without a parallel system.
--
-- Two things that shape fall out of, both wanted:
--   * FlexPay never fronts it. coverLineSql excludes 'carried_balance' by name,
--     and GAM should not advance one landlord's money to pay another landlord's
--     old debt.
--   * It is plainly the resident's to pay, so it shows on their portal beside
--     the rent rather than in a separate place they have to find.
--
-- THIS COLUMN is what lets the money find its way back when the line settles.
-- Without it a settled BALANCE row is indistinguishable from the half-dozen
-- other things that write one (a work-trade settlement, a space-rent
-- carryforward, a re-invited resident's prior balance), and the collection it
-- belongs to would have to be guessed from amounts and dates.
--
-- NO BACKFILL NEEDED: left_owing_collections is new and empty, so no existing
-- payments row belongs to one.

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS left_owing_collection_id uuid
    REFERENCES public.left_owing_collections(id);

COMMENT ON COLUMN public.payments.left_owing_collection_id IS
  '10/27: this bill line is one month of a left-owing collection arrangement '
  '(left_owing_collections). Set only on type=''carried_balance'' rows the '
  'invoice run writes for it; NULL on every other carried balance. When the '
  'line settles, services/leftOwingCollection.applyCollected credits the '
  'arrangement and, once whole, settles the debt so it stops flagging.';

-- The settle path looks a row up by this; the invoice run asks "has this
-- arrangement already been billed for this due date".
CREATE INDEX IF NOT EXISTS idx_payments_left_owing_collection
  ON public.payments (left_owing_collection_id, due_date)
  WHERE left_owing_collection_id IS NOT NULL;

-- One installment per arrangement per due date. The invoice run is replayable
-- by design (a missed night is caught up the next), and without this a catch-up
-- would bill the same month twice.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_left_owing_installment
  ON public.payments (left_owing_collection_id, due_date)
  WHERE left_owing_collection_id IS NOT NULL
    AND status = ANY (ARRAY['pending'::text, 'processing'::text, 'settled'::text]);
