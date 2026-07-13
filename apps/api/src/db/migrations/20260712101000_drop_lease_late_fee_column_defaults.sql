-- S537 (Nic): drop the $15.00 / 5-day column DEFAULTs on leases late-fee
-- columns.
--
-- Why: a column default is a silent late-fee INVENTION — any INSERT that
-- omits the columns (booking auto-draft did exactly this) creates a lease
-- that bills a charge no signed document ever printed. Lease-is-law: a
-- lease silent on late fees has NO late fee. Every code path now writes
-- these columns explicitly (extracted/entered value, else NULL); dropping
-- the defaults makes omission mean NULL for any future path too.
--
-- No backfill: existing rows keep their values — the S537 billing cap
-- (tenant-favorable min vs class policy) bounds any legacy $15 rows, and
-- billing already requires late_fee_initial_amount IS NOT NULL.

ALTER TABLE leases
  ALTER COLUMN late_fee_initial_amount DROP DEFAULT,
  ALTER COLUMN late_fee_grace_days DROP DEFAULT;
