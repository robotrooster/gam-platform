-- Inspection condition model (S573, Nic) — Excellent / Good / Fair /
-- Damaged-or-Missing, and NO "N/A".
--
-- WHY: applicability now comes from the unit's setup (features/counts), so an
-- item that doesn't apply is simply ABSENT — never marked N/A. A seeded-but-
-- not-yet-inspected item is NULL ("not inspected"), not a condition. Damaged and
-- Missing collapse to one option (damaged_missing) per Nic. Excellent is added
-- above Good.
--
-- ORDER MATTERS: drop the old CHECK *before* converting, because the new
-- 'damaged_missing' value isn't in the old allow-list.
--   'na'                  -> NULL  (was the un-inspected placeholder)
--   'damaged' | 'missing' -> 'damaged_missing'
--   'good' | 'fair'       -> unchanged
ALTER TABLE unit_inspection_items ALTER COLUMN condition DROP NOT NULL;
ALTER TABLE unit_inspection_items DROP CONSTRAINT IF EXISTS unit_inspection_items_condition_check;

UPDATE unit_inspection_items SET condition = NULL              WHERE condition = 'na';
UPDATE unit_inspection_items SET condition = 'damaged_missing' WHERE condition IN ('damaged', 'missing');

ALTER TABLE unit_inspection_items ADD CONSTRAINT unit_inspection_items_condition_check
  CHECK (condition IS NULL OR condition = ANY (ARRAY['excellent'::text, 'good'::text, 'fair'::text, 'damaged_missing'::text]));
