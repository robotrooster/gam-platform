-- S652 — stock in the register can be fractional.
--
-- Nic: "the charge when you go to charge a transaction on propane at Mountain
-- View RV, it still glitching out and staying as a suspended type of ticket.
-- It's not completing the sale."
--
-- Propane is sold by the gallon and the register takes decimal quantities
-- (deploy 64). The sale writes the stock change into INTEGER columns, so
-- 4.6 gallons was refused by the database ("invalid input syntax for type
-- integer"), the whole sale rolled back, and the register — which had no error
-- handler — left the tab open. Whole-number sales (13, 20 gallons) went
-- through, which is why it looked intermittent.
ALTER TABLE pos_items
  ALTER COLUMN stock_qty TYPE numeric(12,3) USING stock_qty::numeric;
ALTER TABLE pos_item_variants
  ALTER COLUMN stock_qty TYPE numeric(12,3) USING stock_qty::numeric;
ALTER TABLE pos_inventory_log
  ALTER COLUMN change_qty   TYPE numeric(12,3) USING change_qty::numeric,
  ALTER COLUMN stock_before TYPE numeric(12,3) USING stock_before::numeric,
  ALTER COLUMN stock_after  TYPE numeric(12,3) USING stock_after::numeric;
