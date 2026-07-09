-- Begin/end reading snapshots on bills (Nic, S533).
--
-- The tenant's invoice must show beginning read, ending read, and
-- total usage for metered charges — the blind-entry rule protects the
-- READER from bias during the walk; the TENANT gets full transparency
-- on what produced the charge. Values snapshot at generation (S90
-- posture). A rollover bill shows end < start honestly (999822 →
-- 000138); usage_amount already carries the wrap-corrected usage.
-- RUBS bills leave these NULL (master totals, not per-unit odometers).
--
-- No backfill needed: NULL renders as "—" for pre-existing bills.

ALTER TABLE utility_bills
    ADD COLUMN reading_start numeric,
    ADD COLUMN reading_end   numeric;
