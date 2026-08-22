-- S616: the COLUMN default follows the rate, so a fresh install starts at 3%
-- rather than seeding a 5% row that nobody meant to create.
ALTER TABLE platform_fee_config ALTER COLUMN str_fee_pct SET DEFAULT 0.03;
