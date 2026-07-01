-- POS categories: single property_id → a SET of properties (property_ids).
--
-- A category can now be toggled on per property (e.g. a 4-property portfolio
-- where only 3 sell propane → the "Propane" category is active at those 3).
-- The old model only allowed "one property" or "company-wide (all)".
--
-- Semantics of property_ids:
--   NULL  → the category applies to ALL properties (company-wide default,
--           including any properties added later).
--   array → the category applies ONLY to the listed properties.
--
-- Backfill: an existing single property_id becomes a one-element array; NULL
-- property_id stays NULL (= all). The legacy property_id column is kept in
-- place but is no longer read by the category logic.
ALTER TABLE pos_categories ADD COLUMN IF NOT EXISTS property_ids uuid[];

UPDATE pos_categories
   SET property_ids = ARRAY[property_id]
 WHERE property_id IS NOT NULL AND property_ids IS NULL;
