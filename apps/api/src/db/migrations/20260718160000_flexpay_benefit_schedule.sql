-- S545b (Nic): benefit schedules tailored to how the programs pay.
--
-- "Day 22" is not how SSA schedules work. Real patterns:
--   SSI            → 1st of the month
--   SSDI           → 3rd of the month (pre-May-1997 claims), else by
--                    birth date: 2nd / 3rd / 4th Wednesday
--   other fixed    → a plain day of month
-- The tenant now picks the PATTERN per income type; the platform
-- derives desired_pull_day as the LATEST day that pattern can land
-- (2nd Wed ≤ 14, 3rd Wed ≤ 21, 4th Wed ≤ 28) so float math and queue
-- ordering keep working unchanged on a conservative estimate.
--
-- No backfill needed: existing rows keep their raw desired_pull_day;
-- schedule shows '—' until captured.

ALTER TABLE flexpay_inquiries
  ADD COLUMN benefit_schedule text
  CHECK (benefit_schedule IS NULL OR benefit_schedule IN
    ('ssi_day_1', 'ssdi_day_3', 'ssdi_wed_2', 'ssdi_wed_3', 'ssdi_wed_4', 'fixed_day'));
