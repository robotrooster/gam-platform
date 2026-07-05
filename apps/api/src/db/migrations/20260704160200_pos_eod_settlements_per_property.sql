-- W-12 (final walkthrough, S531): POS full per-property separation.
-- EOD settlements were one row per (landlord, business_day) — every
-- property's sales and cash drawer mixed into a single settlement, which
-- makes multi-property drawer reconciliation impossible. Settlements are
-- now per (landlord, property, business_day): each register/location
-- closes its own day.
--
-- The table is EMPTY in every environment (the engine + cron exist but no
-- UI consumed them yet, and dev has 0 rows) — so property_id can be
-- NOT NULL from the start and the unique anchor swaps cleanly. No
-- backfill needed.

ALTER TABLE pos_eod_settlements
  ADD COLUMN property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE;

ALTER TABLE pos_eod_settlements DROP CONSTRAINT pos_eod_settlements_one_per_day;
ALTER TABLE pos_eod_settlements ADD CONSTRAINT pos_eod_settlements_one_per_day
  UNIQUE (landlord_id, property_id, business_day);
