-- S241: pos_items.property_id NOT NULL.
--
-- Pre-S241 the column was added as NULLABLE (S192) with the convention
-- "NULL = landlord-wide". Nic-confirmed per-property semantics for v1:
-- different LLC operators commonly run different properties, and a
-- landlord-wide POS item makes no sense once any property is operated
-- by a separate entity. Every pos_item must now belong to a property.
--
-- Backfill: zero existing rows in pos_items at migration time (verified
-- via SELECT COUNT(*)). No backfill needed. If this migration is run
-- against a database with existing landlord-wide rows, it WILL fail
-- on the NOT NULL constraint — that's correct; admin would need to
-- decide on a per-property assignment first.

ALTER TABLE pos_items
  ALTER COLUMN property_id SET NOT NULL;

COMMENT ON COLUMN pos_items.property_id IS
  'Property this POS item belongs to. NOT NULL post-S241 — per-property is the v1 posture (different LLC operators per property is common). Low-stock notifications route via the property''s responsible party (per services/responsibleParty.ts).';
