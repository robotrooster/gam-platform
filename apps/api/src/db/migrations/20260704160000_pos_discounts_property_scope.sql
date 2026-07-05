-- W-12 (final walkthrough, S531): POS full per-property separation.
-- Discounts join tax rates in the per-property settings model: NULL
-- property_id = company-wide (visible at every property, same UNION-read
-- posture as pos_tax_rates S217), a uuid scopes the discount to one
-- property. Existing rows stay NULL (company-wide) — no backfill needed;
-- that preserves current behavior exactly.

ALTER TABLE pos_discounts
  ADD COLUMN property_id uuid REFERENCES properties(id) ON DELETE CASCADE;

CREATE INDEX idx_pos_discounts_property ON pos_discounts (landlord_id, property_id);
