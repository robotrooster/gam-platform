-- S605 (Nic, DIRECTIVE): property inventory is EQUIPMENT, and it lives at a
-- property.
--
-- "Inventory needs to be scoped to property. It's not a shared thing. It's not
-- the same as inventory for the point of sale. Property inventory is equipment —
-- small tractors, weed whackers, tools, other supplies to operate that property.
-- That has the ability to scope preventative maintenance or service on oil
-- changes and things like that on machines."
--
-- `parts_inventory` was scoped to the LANDLORD only, so a landlord with four
-- parks saw one undifferentiated list and could not answer "which mower is at
-- Oak Park?" — the question the table exists to answer. Nothing about a tractor
-- is portfolio-wide; it is physically somewhere.
--
-- Distinct from business_inventory_items (POS stock for a retail counter), which
-- stays exactly where it is. Same word, different thing.
--
-- NULLABLE on purpose. Existing rows have no property and guessing one would
-- invent a fact; NULL reads as "not assigned to a property yet", which is also
-- the honest state for a central shop or a trailer that moves between parks. New
-- items created from inside a property carry it automatically.
--
-- ON DELETE SET NULL rather than CASCADE: selling a property should not delete
-- the record of a tractor. It becomes unassigned, and the landlord re-homes it.

ALTER TABLE parts_inventory
  ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES properties(id) ON DELETE SET NULL;

COMMENT ON COLUMN parts_inventory.property_id IS
  'S605: the property this equipment lives at. NULL = unassigned (central shop, or predates property scoping). Not related to business_inventory_items, which is POS stock.';

CREATE INDEX IF NOT EXISTS idx_parts_inventory_property
  ON parts_inventory (property_id) WHERE property_id IS NOT NULL;

-- A landlord with one property has exactly one right answer, so assign their
-- existing equipment rather than leaving it in an unassigned limbo they would
-- have to clear by hand. Landlords with several are left alone — there is no
-- way to know which park the mower is at.
UPDATE parts_inventory pi
   SET property_id = p.id
  FROM properties p
 WHERE pi.property_id IS NULL
   AND p.landlord_id = pi.landlord_id
   AND (SELECT COUNT(*) FROM properties p2 WHERE p2.landlord_id = pi.landlord_id) = 1;
