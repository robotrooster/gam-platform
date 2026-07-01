-- Allow the same POS category name across DIFFERENT properties.
--
-- Bug: the old UNIQUE (landlord_id, name) blocked adding a "Fuel" category to
-- property B when property A already had a "Fuel" category — even though they
-- are scoped to different properties. POS operators legitimately want the same
-- category per location (fuel/laundry/etc. sold at each property).
--
-- Replace the single constraint with scope-aware uniqueness:
--   - at most ONE account-wide category per name (property_id IS NULL)
--   - at most ONE per-property category per (name, property_id)
-- So "Fuel" (account-wide) + "Fuel" @ property A + "Fuel" @ property B all
-- coexist, but duplicates within a single scope are still rejected (23505).
--
-- No backfill needed: the prior constraint was strictly tighter, so existing
-- rows already satisfy both new indexes.
ALTER TABLE pos_categories DROP CONSTRAINT IF EXISTS pos_categories_landlord_name_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS pos_categories_global_name_uniq
  ON pos_categories (landlord_id, name)
  WHERE property_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS pos_categories_property_name_uniq
  ON pos_categories (landlord_id, name, property_id)
  WHERE property_id IS NOT NULL;
