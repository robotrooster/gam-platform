-- S100: extend the S99 stock-guard pattern to sibling inventory /
-- transaction-line tables.
--
-- parts_inventory.quantity >= 0
--   Maintenance-side inventory position. Same posture as
--   pos_items.stock_qty in S99: 0 is a valid "out of stock" state,
--   negative is never legitimate. The route at maintenance-portal.ts:110
--   does a COALESCE($1,quantity) PATCH; today nothing prevents a caller
--   from PATCHing a negative quantity.
--
-- pos_purchase_order_items.qty_ordered > 0
--   PO line item. Unlike a stock count, a 0-qty PO line is itself a
--   data bug — there is no scenario where ordering zero of something is
--   legitimate. Tighter than the S99 pattern (>0 not >=0). Routes at
--   pos.ts:221 / 629 / 650 INSERT lines from request bodies.
--
-- pos_transaction_items.qty > 0
--   Sale line item. Same reasoning: a 0-qty sale line is invalid.
--   Route at pos.ts:177 INSERTs lines from cart payload.
--
-- Existing rows: dev DB inspected and contains 0 violating rows. No
-- backfill needed. If future production data violates, the ALTER will
-- fail loud and the offending rows must be repaired before the
-- migration applies (fix-forward — write a cleanup migration that
-- deletes/repairs the bad rows, then re-run).

ALTER TABLE parts_inventory
  ADD CONSTRAINT parts_inventory_quantity_nonneg CHECK (quantity >= 0);

ALTER TABLE pos_purchase_order_items
  ADD CONSTRAINT pos_purchase_order_items_qty_ordered_pos CHECK (qty_ordered > 0);

ALTER TABLE pos_transaction_items
  ADD CONSTRAINT pos_transaction_items_qty_pos CHECK (qty > 0);
