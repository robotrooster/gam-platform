-- W-12 (final walkthrough, S531): POS full per-property separation.
-- A purchase order receives stock at ONE location — its line items point
-- at per-property pos_items rows, so the PO itself carries the receiving
-- property. NULL = legacy rows created before this migration (displayed
-- landlord-wide); new POs stamp the property they're created under.
-- No backfill needed — dev has no PO history worth attributing.

ALTER TABLE pos_purchase_orders
  ADD COLUMN property_id uuid REFERENCES properties(id) ON DELETE CASCADE;

CREATE INDEX idx_pos_purchase_orders_property ON pos_purchase_orders (landlord_id, property_id);
