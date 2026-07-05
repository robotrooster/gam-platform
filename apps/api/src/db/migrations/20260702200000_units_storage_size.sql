-- Storage units get a landlord-entered SIZE (freeform, e.g. '10x10') — the
-- sub-type dimension for storage in the S526 unit-type model. Pricing
-- overrides key on it ('size:<value>') and the pricing menus only list sizes
-- the landlord has actually used (no invented catalog).
-- No backfill needed: NULL = size not recorded.
ALTER TABLE units ADD COLUMN IF NOT EXISTS storage_size text;
