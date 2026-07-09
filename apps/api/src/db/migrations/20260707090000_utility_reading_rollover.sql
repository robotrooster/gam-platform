-- Rollover confirmation on meter readings (S533).
--
-- Meters are 6-digit odometers: past 999999 they wrap to 000000, so a
-- genuine end-of-month read can be BELOW the previous one (999822 →
-- 000138). The blind walk already flags below-previous entries for the
-- landlord double-check; this column records the landlord's verdict.
-- is_rollover = TRUE means "confirmed: the meter wrapped" — the billing
-- engine then computes usage as (1,000,000 − prior) + current instead
-- of skipping on negative usage. A confirmed METER SWAP/reset stays
-- FALSE (new meter, unknown usage — nothing bills that cycle).
--
-- The flag is only ever set through the resolve-review path (after a
-- human looked at the meter), never at entry time — automatic wrap
-- billing on a typo'd low read would produce a ~1M-unit bill.
--
-- No backfill needed: no reading predating this column was ever
-- confirmed as a rollover.

ALTER TABLE utility_meter_readings
    ADD COLUMN is_rollover boolean NOT NULL DEFAULT false;
