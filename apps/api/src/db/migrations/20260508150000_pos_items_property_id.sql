-- S192: per-property POS items.
--
-- Pre-S192 pos_items was landlord-scoped — every item visible at every
-- property under the landlord. Under the GAM RV-park / extended-stay
-- model, POS happens AT a property (front office, RV-park camp store,
-- extended-stay convenience kiosk). Same landlord may run different
-- inventory at different sites.
--
-- Side-effect this fixes: notifyLowStock (jobs/scheduler.ts) was
-- landlord-scoped and could not be routed through the S183
-- responsible-party resolver. With property_id available on the item,
-- low-stock alerts can route to the manager / PM company actually
-- responsible for that property — owners who have delegated
-- properties stop getting low-stock pings for inventory they don't
-- manage.
--
-- Backfill posture: leave property_id NULL on existing items.
-- Pre-S192 semantic was "applies landlord-wide" and we don't know
-- which property a given item should belong to without product
-- input. Post-S192:
--   - items with property_id set → property-scoped, route via resolver
--   - items with property_id NULL → landlord-scoped, route to owner
--     (legacy posture)
-- This is forward-compatible: a landlord can re-assign existing items
-- to specific properties via the new PATCH path, or leave them
-- landlord-wide.

ALTER TABLE pos_items
  ADD COLUMN property_id uuid REFERENCES properties(id) ON DELETE SET NULL;

CREATE INDEX idx_pos_items_property
  ON pos_items(property_id)
  WHERE property_id IS NOT NULL;

COMMENT ON COLUMN public.pos_items.property_id IS
  'Property this POS item belongs to. NULL = landlord-wide (legacy posture). When set, low-stock notifications route to the property''s responsible party (per services/responsibleParty.ts) instead of the landlord owner.';
