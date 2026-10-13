-- 10/12 (Nic) — GAM BOOKS LEDGER: HOW REGISTER STOCK IS COUNTED IS THE COMPANY'S CHOICE
--
-- Nic, 10/12 (L8): register stock is the LANDLORD'S CHOICE —
--   expense_when_bought  stock is an expense the day it is bought (the money-out
--                        record of the purchase says so); a register sale posts
--                        no cost of its own;
--   cost_per_item_sold   stock bought is inventory, and each register sale moves
--                        what its items cost (pos_transaction_items.cost_price ×
--                        qty, recorded with the sale) from Inventory (1210) to
--                        Cost of goods sold (5300) on the sale's day.
-- The ledger's register-sale projector (services/ledgerProjectors/registerSale)
-- reads it; the money-out phase (P6) reads the same choice to file a stock
-- purchase as inventory instead of an expense.
--
-- books_register_stock_from: the first day the current choice applies (NULL =
-- from the books start). A change of mind applies from the day it is made, so
-- sales already booked keep the cost treatment they were booked with and a
-- rebuild comes out the same.
--
-- Default: the design's recommendation (expense when bought). Values match
-- LEDGER_REGISTER_STOCK_METHODS in packages/shared/src/booksLedger.ts.
--
-- The ledger is DARK: nothing posts until the projector phases are registered.
-- Expand-only, safe to apply before the code ships.
-- No backfill needed: every company starts on the default; nothing has posted.
-- Safe drop: ALTER TABLE landlords DROP COLUMN books_register_stock,
--            DROP COLUMN books_register_stock_from (and the CHECK).

SET LOCAL lock_timeout = '10s';

ALTER TABLE landlords
  ADD COLUMN IF NOT EXISTS books_register_stock      text NOT NULL DEFAULT 'expense_when_bought',
  ADD COLUMN IF NOT EXISTS books_register_stock_from date;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'landlords_books_register_stock_check') THEN
    ALTER TABLE landlords
      ADD CONSTRAINT landlords_books_register_stock_check
        CHECK (books_register_stock IN ('expense_when_bought', 'cost_per_item_sold'));
  END IF;
END $$;

COMMENT ON COLUMN landlords.books_register_stock IS
  '10/12 (Nic, L8): register stock — expense_when_bought or cost_per_item_sold (Inventory → Cost of goods sold per sale). LEDGER_REGISTER_STOCK_METHODS.';
COMMENT ON COLUMN landlords.books_register_stock_from IS
  '10/12 (Nic, L8): the first day the current register-stock choice applies (NULL = from the books start); earlier sales keep their treatment.';
