-- S217: per-property POS tax rates.
--
-- Same property-scoping pattern as S192's pos_items. Pre-S217
-- pos_tax_rates was landlord-scoped — every configured rate
-- visible at every property under the landlord. Under the GAM
-- multi-state landlord model, the sharp edge is state-line
-- scenarios: a landlord with property in AZ and property in CA
-- needs different rate configs (different state sales tax,
-- different RV-rental tax treatment) but pre-S217 had to share
-- one library.
--
-- Backfill posture: leave property_id NULL on existing rates.
-- Pre-S217 semantic was "applies landlord-wide"; post-S217:
--   - rates with property_id set    → property-scoped library
--   - rates with property_id NULL   → landlord-wide library
--                                     (legacy posture)
-- Forward-compatible: landlord can re-assign existing rates via
-- the new PATCH path, or leave them landlord-wide.
--
-- Note on cart math: pre-S217 the POS cart math uses each item's
-- per-item `tax_rate` field, not the pos_tax_rates table. This
-- migration is forward-looking — schema lands now so a future
-- session can wire the cart to consume property-scoped rate
-- definitions (e.g. apply state sales tax automatically based on
-- the property the sale is at).

ALTER TABLE pos_tax_rates
  ADD COLUMN property_id uuid REFERENCES properties(id) ON DELETE SET NULL;

CREATE INDEX idx_pos_tax_rates_property
  ON pos_tax_rates(property_id)
  WHERE property_id IS NOT NULL;

COMMENT ON COLUMN public.pos_tax_rates.property_id IS
  'Property this tax rate applies at. NULL = landlord-wide (legacy posture). Forward-looking: wire cart math to filter applicable rates by the property the sale is recorded at.';
