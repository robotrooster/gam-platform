-- S294: extra-data overflow for CSV imports.
--
-- Until now, the CSV-import pipeline (apps/api/src/lib/csvImportMappings.ts)
-- dropped any source-platform column that wasn't either mapped to a GAM
-- canonical header or explicitly listed in the platform's ignoredColumns
-- array. Two failure modes that caused:
--
--   1) Columns a migrating customer cares about (lease IDs, unit codes,
--      year built, additional contact info) disappeared on import with no
--      recovery path.
--   2) Unknown columns from un-researched platforms or off-template exports
--      vanished silently, hiding mapping gaps from us instead of surfacing
--      them as data we could review.
--
-- This migration adds a nullable JSONB overflow column to each of the three
-- target tables CSV imports write to. The mapping pipeline (S294 code
-- changes alongside this migration) routes any source column that isn't
-- canonical-mapped AND isn't on the platform's true-noise list into this
-- JSONB. Original-case column headers preserved as JSON keys so the
-- super admin review queue (S295) can show landlords' exact uploaded
-- shape.
--
-- Tables touched:
--   - leases.import_extra_data    — tenant CSV extras (one row per CSV row)
--   - units.import_extra_data     — property CSV extras (one row per CSV row;
--                                   property-level extras like Year Built
--                                   get duplicated across each unit on a
--                                   multi-unit property — accepted; the
--                                   data is for review, not querying)
--   - payments.import_extra_data  — payment-history CSV extras
--
-- No backfill needed — existing rows weren't created via this overflow
-- pipeline, so leaving them NULL is correct.

ALTER TABLE leases   ADD COLUMN import_extra_data jsonb;
ALTER TABLE units    ADD COLUMN import_extra_data jsonb;
ALTER TABLE payments ADD COLUMN import_extra_data jsonb;
