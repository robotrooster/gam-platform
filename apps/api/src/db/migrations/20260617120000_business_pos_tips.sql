-- S512 (G): POS tip handling.
--
-- Service businesses (salons, food, mobile service) collect tips at the
-- register. A tip is NOT sales revenue — it passes through to staff — so
-- it is tracked in its OWN column, separate from total_amount.
--
-- Money model:
--   total_amount  = subtotal + tax            (the SALE — unchanged)
--   tip_amount    = customer-added gratuity    (new, default 0)
--   grand total charged = total_amount + tip_amount
-- The grand total is what cash tendered must cover and what the receipt
-- shows as the final line; it is computed at charge/render time, never
-- stored (total_amount stays the canonical sales figure so every existing
-- revenue aggregation keeps meaning "sales", not "sales + tips").
--
-- SAFE — additive only, default 0, no backfill needed (existing sales
-- carried no tip).

ALTER TABLE public.business_pos_transactions
  ADD COLUMN tip_amount numeric(10,2) DEFAULT 0 NOT NULL;

ALTER TABLE public.business_pos_transactions
  ADD CONSTRAINT business_pos_transactions_tip_nonneg CHECK (tip_amount >= 0);

COMMENT ON COLUMN public.business_pos_transactions.tip_amount IS
  'S512 customer gratuity, tracked separately from total_amount (which stays sale-only). Grand total charged = total_amount + tip_amount.';
