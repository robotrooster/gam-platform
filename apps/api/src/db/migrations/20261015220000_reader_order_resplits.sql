-- 10/13 evening (Nic) — A CARD READER'S COST CORRECTED AFTER PIECES ARE BOOKED: REDO THE SPLIT.
--
-- Nic chose "Redo the split": a cost correction after pieces are booked REDOES
-- the split, as a dated correction. Until now a correction booked only the
-- purchase difference; the pieces already booked kept the split of the cost
-- they were billed under, so after $5.00 more shipping the Markup slice still
-- said $18.27 when the reader earns $13.27 beyond its cost.
--
-- With the code that ships beside this (@gam/shared readerBookRows,
-- services/readerOrders bookReaderBook), each piece already billed is split
-- again under the corrected cost, cost first, and what moves between its cost
-- repaid and its markup is booked on the correction's date — the rows booked
-- before stay as they were, a piece's own rows stay dated the day it was
-- billed. One row here per piece and cost entry it was split again under: the
-- reference the two ledger rows of that re-split name (platform_revenue_ledger
-- reference_id; 'adjustment' / 'reader_cost_repaid' for the cost-repaid
-- difference, 'device_markup' / 'reader_resplit' for the markup difference —
-- @gam/shared READER_BOOK_REFERENCE). The ledger's own unique index (reference,
-- reference_type, type) keeps each re-split booked once.
--
-- No money column: the amounts are the ledger's rows. Rows are never deleted
-- (nothing in the product removes one; a piece or cost entry is never deleted
-- either, so the RESTRICT foreign keys never fire in production).
--
-- Production: Mountain View (order 288cc5df) has one cost entry and one piece,
-- so nothing is re-split at deploy. Expand-only; no backfill needed;
-- idempotent. Safe to drop once nothing references it (the ledger rows that
-- name it would lose their link back to the piece).

CREATE TABLE IF NOT EXISTS pos_reader_order_resplits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reader_order_id uuid NOT NULL REFERENCES pos_reader_orders(id),
  -- The piece split again (its landlord_gam_charges row).
  charge_id       uuid NOT NULL REFERENCES landlord_gam_charges(id),
  -- The cost entry it is split again under.
  cost_id         uuid NOT NULL REFERENCES pos_reader_order_costs(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_reader_order_resplits_once UNIQUE (charge_id, cost_id)
);

CREATE INDEX IF NOT EXISTS pos_reader_order_resplits_order ON pos_reader_order_resplits (reader_order_id);

COMMENT ON TABLE pos_reader_order_resplits IS
  '10/13 (Nic: "Redo the split"): a card-reader piece split again under a later cost entry. Its id is the reference of the cost-repaid and markup difference rows in platform_revenue_ledger.';
