-- Per-meter digit width (S533).
--
-- Meters are odometers of varying width: RV pedestals are commonly 6
-- digits, water meters often 4, some 7-8. Rollover math depends on the
-- width — a 4-digit meter wraps at 9999→0000, so locking the platform
-- to 6 digits would compute a 4-digit rollover as (1,000,000 − 9,822)
-- + 138 instead of (10,000 − 9,822) + 138. The landlord sets digits
-- per meter (default 6).
--
-- Allowed values mirror METER_READING_DIGIT_OPTIONS in packages/shared
-- (single-source rule) — extend both together.
--
-- No backfill needed beyond the DEFAULT: every existing meter is a
-- 6-digit RV pedestal from the demo seed.

ALTER TABLE utility_meters
    ADD COLUMN digits integer NOT NULL DEFAULT 6
    CONSTRAINT utility_meters_digits_check CHECK (digits IN (4, 5, 6, 7, 8));
