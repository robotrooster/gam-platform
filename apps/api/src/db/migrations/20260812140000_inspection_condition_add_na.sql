-- S602 (Nic): re-add 'na' (N/A) as a selectable inspection item condition,
-- reversing S573's removal. N/A = the item doesn't apply to THIS unit (e.g. no
-- dishwasher) — distinct from an un-inspected item, which stays NULL. Damaged
-- and Missing remain COMBINED as 'damaged_missing'. N/A is excluded from the
-- move-out worse-than comparison and never charges a fee. No backfill needed.

ALTER TABLE unit_inspection_items DROP CONSTRAINT IF EXISTS unit_inspection_items_condition_check;

ALTER TABLE unit_inspection_items
  ADD CONSTRAINT unit_inspection_items_condition_check
  CHECK ((condition IS NULL) OR (condition = ANY (ARRAY['excellent'::text, 'good'::text, 'fair'::text, 'damaged_missing'::text, 'na'::text])));
