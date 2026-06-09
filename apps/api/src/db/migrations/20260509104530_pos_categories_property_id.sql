-- S220: per-property POS categories.
--
-- Same property-scoping pattern as S192 (pos_items) and S217
-- (pos_tax_rates). Pre-S220 pos_categories was landlord-scoped —
-- every category visible at every property under the landlord. The
-- multi-property landlord case it solves: a landlord with an RV park
-- + an extended-stay convenience kiosk wants different category
-- vocabularies (RV park has "Fuel", "Firewood"; convenience kiosk has
-- "Snacks", "Beverages"). Pre-S220 they had to share one library.
--
-- Backfill posture: leave property_id NULL on existing rows. Pre-S220
-- semantic was "applies landlord-wide" and the auto-seeded defaults
-- (Fuel/Amenity/Laundry/Parking/Fee/Misc) genuinely are landlord-wide
-- — the landlord can re-scope individual ones via the new PATCH path
-- if they want to.
--
-- Post-S220 semantic:
--   - categories with property_id set  → property-scoped
--                                        (only appear in dropdowns
--                                        when the consuming surface's
--                                        property matches)
--   - categories with property_id NULL → landlord-wide
--                                        (appear in every property's
--                                        dropdown)
--
-- pos_items.category is a free-text column (not an FK), so re-scoping
-- a category does NOT cascade to existing items pointing at it. UI
-- surfaces a warning, same posture as the S219 rename warning.

ALTER TABLE pos_categories
  ADD COLUMN property_id uuid REFERENCES properties(id) ON DELETE SET NULL;

CREATE INDEX idx_pos_categories_property
  ON pos_categories(property_id)
  WHERE property_id IS NOT NULL;

COMMENT ON COLUMN public.pos_categories.property_id IS
  'Property this category applies at. NULL = landlord-wide (default; legacy posture). Property-scoped categories only appear in dropdowns at that property — landlord-wide categories appear everywhere.';
