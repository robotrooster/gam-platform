-- Per-property propane split thresholds (Nic, S534).
--
-- The 40 / 100 gallon split boundaries were Nic's answers wearing his
-- LANDLORD hat, not platform rules — if the landlord can toggle splits
-- on or off, they set the gallon thresholds too (platform simplicity
-- rule: flexibility lives in per-property toggles). Split options stay
-- 2 or 4 only; what moves per property is WHEN each becomes available:
--   propane_split_min_gallons       — below this a fill can't split
--   propane_split_four_min_gallons  — below this 4-way is unavailable
-- Defaults mirror the previous platform constants (shared
-- PROPANE_SPLIT_MIN_GALLONS / PROPANE_SPLIT_FOUR_MIN_GALLONS), which
-- remain in packages/shared as the new-property defaults.
--
-- No backfill needed: defaults apply to every existing property.

ALTER TABLE properties
    ADD COLUMN propane_split_min_gallons integer NOT NULL DEFAULT 40
        CHECK (propane_split_min_gallons > 0),
    ADD COLUMN propane_split_four_min_gallons integer NOT NULL DEFAULT 100;

ALTER TABLE properties
    ADD CONSTRAINT properties_propane_split_four_gte_min_check
        CHECK (propane_split_four_min_gallons >= propane_split_min_gallons);
