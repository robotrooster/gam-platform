-- S227: Refactor pos_items.category from free-text string to a proper
-- FK reference to pos_categories.id, and add a (landlord_id, name)
-- UNIQUE on pos_categories.
--
-- Why now:
--   - Category names on pos_items today are linked to pos_categories
--     entries by string match only. Renaming a category in the
--     management UI does NOT cascade to items pointing at the old
--     name (POSPage.tsx surfaces a warning about this exact thing).
--   - Without UNIQUE on pos_categories(landlord_id, name), two
--     categories with the same name on the same landlord become a
--     silent data-quality bug.
--   - pos_transaction_items.item_category is unrelated — it's a
--     denormalized snapshot at sale time and stays as text.
--
-- Migration outline:
--   1. Dedupe pos_categories by (landlord_id, name) keeping the
--      oldest row per group; reassign would-be-orphaned references
--      (none today, but defensive).
--   2. Add UNIQUE (landlord_id, name) to pos_categories.
--   3. Seed pos_categories for any (landlord_id, category) pair
--      present on pos_items but missing from pos_categories. New
--      rows get sort_order based on alphabetical position to give
--      deterministic ordering.
--   4. Add pos_items.category_id uuid (nullable initially).
--   5. Backfill pos_items.category_id from the matching
--      pos_categories row.
--   6. SET NOT NULL on pos_items.category_id.
--   7. Drop the old category-text-based idx_pos_items_landlord;
--      replace with category_id-based variant.
--   8. Drop pos_items.category column.
--
-- Backfill safety: the seed step (3) guarantees every pos_items.category
-- has a corresponding pos_categories row, so the backfill (5) cannot
-- leave a NULL. The NOT NULL in (6) is therefore safe.

BEGIN;

-- 1. Dedupe pos_categories by (landlord_id, name) — keep oldest.
WITH duplicates AS (
  SELECT id,
         landlord_id,
         name,
         ROW_NUMBER() OVER (PARTITION BY landlord_id, name ORDER BY created_at, id) AS rn
    FROM pos_categories
)
DELETE FROM pos_categories
 WHERE id IN (SELECT id FROM duplicates WHERE rn > 1);

-- 2. UNIQUE on pos_categories(landlord_id, name) — case-sensitive
--    matches the existing seed/insert pattern (categories like
--    'Misc' and 'misc' would be treated as distinct, which is fine
--    for now; no normalization layer in place).
ALTER TABLE pos_categories
  ADD CONSTRAINT pos_categories_landlord_name_uniq UNIQUE (landlord_id, name);

-- 3. Seed pos_categories for any (landlord_id, category) on pos_items
--    that doesn't already have a row. Ordering for sort_order: append
--    after existing max sort_order per landlord, alphabetical.
INSERT INTO pos_categories (landlord_id, name, icon, sort_order, is_active)
SELECT pi.landlord_id,
       pi.category,
       '📦',
       COALESCE(
         (SELECT MAX(sort_order) FROM pos_categories pc WHERE pc.landlord_id = pi.landlord_id),
         0
       ) + ROW_NUMBER() OVER (PARTITION BY pi.landlord_id ORDER BY pi.category),
       true
  FROM (SELECT DISTINCT landlord_id, category FROM pos_items) pi
 WHERE NOT EXISTS (
   SELECT 1 FROM pos_categories pc
    WHERE pc.landlord_id = pi.landlord_id AND pc.name = pi.category
 );

-- 4. Add the new column.
ALTER TABLE pos_items
  ADD COLUMN category_id uuid REFERENCES pos_categories(id) ON DELETE RESTRICT;

-- 5. Backfill from the matching pos_categories row.
UPDATE pos_items pi
   SET category_id = pc.id
  FROM pos_categories pc
 WHERE pc.landlord_id = pi.landlord_id
   AND pc.name = pi.category;

-- 6. NOT NULL — every row should now have a category_id.
ALTER TABLE pos_items
  ALTER COLUMN category_id SET NOT NULL;

-- 7. Replace the category-text index with a category_id variant.
DROP INDEX IF EXISTS idx_pos_items_landlord;
CREATE INDEX idx_pos_items_landlord
  ON pos_items (landlord_id, category_id, name)
  WHERE is_active = true;

-- 8. Drop the legacy text column.
ALTER TABLE pos_items
  DROP COLUMN category;

COMMIT;
