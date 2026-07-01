-- Revert 20260630150000: category names are unique per landlord again (NO
-- duplicates). The per-property duplicate approach was the wrong solution —
-- the real need is filtering SALES between properties, which is done on the
-- transaction/sale side (each sale is stamped with its property), not by
-- duplicating categories per property.
--
-- Fix-forward: drop the two scope-aware partial indexes and restore the single
-- (landlord_id, name) unique constraint. Safe: there are currently no duplicate
-- category names (any per-property dupes created during testing were removed).
DROP INDEX IF EXISTS pos_categories_global_name_uniq;
DROP INDEX IF EXISTS pos_categories_property_name_uniq;

ALTER TABLE pos_categories
  ADD CONSTRAINT pos_categories_landlord_name_uniq UNIQUE (landlord_id, name);
