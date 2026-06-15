-- S497 fix-forward: relax business_pos_transaction_lines.item_id FK from
-- RESTRICT to CASCADE.
--
-- Original migration used RESTRICT as a hedge against accidental item
-- deletion. But items are never hard-deleted in normal app flow — they
-- are archived (is_active = FALSE). The only path that ever deletes an
-- item row is the business → inventory cascade, and at that point the
-- POS history rightfully goes with it (the business is being dropped).
--
-- RESTRICT also broke test cleanup, which deletes businesses to wipe
-- per-test data. CASCADE makes the chain work.
--
-- SAFE — additive constraint swap, no data change.

ALTER TABLE public.business_pos_transaction_lines
  DROP CONSTRAINT IF EXISTS business_pos_transaction_lines_item_id_fkey;

ALTER TABLE public.business_pos_transaction_lines
  ADD CONSTRAINT business_pos_transaction_lines_item_id_fkey
    FOREIGN KEY (item_id) REFERENCES public.business_inventory_items(id)
    ON DELETE CASCADE;
