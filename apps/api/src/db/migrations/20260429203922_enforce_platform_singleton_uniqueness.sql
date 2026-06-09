-- Corrects a defect introduced by 20260429203241_seed_platform_singletons.sql.
-- That migration's INSERT ... ON CONFLICT DO NOTHING relied on a primary-key
-- collision to no-op against existing rows, but the PK default is uuid_generate_v4(),
-- so each insert produced a brand-new UUID and the conflict never fired.
-- Result on the dev DB: two rows in each table where there should be exactly one.
--
-- This migration:
--   1. Collapses each table to a single row. Both rows in each table have
--      identical values (verified pre-migration), so picking by id ORDER BY ASC
--      is arbitrary but deterministic. The surviving row carries forward.
--   2. Adds a partial unique index on a constant expression to enforce
--      "at most one row, ever" at the database level. Future inserts of a
--      second row will fail with a unique-constraint violation, regardless
--      of what UUID they carry.
--
-- Per migration policy, the previous migration is not edited. The checksum
-- guard in migrate.ts depends on applied files staying byte-identical.

-- reserve_fund_state — collapse to one row, then enforce.
DELETE FROM reserve_fund_state
 WHERE id NOT IN (SELECT id FROM reserve_fund_state ORDER BY id LIMIT 1);

CREATE UNIQUE INDEX IF NOT EXISTS reserve_fund_state_singleton
  ON reserve_fund_state ((true));

-- float_account_state — collapse to one row, then enforce.
DELETE FROM float_account_state
 WHERE id NOT IN (SELECT id FROM float_account_state ORDER BY id LIMIT 1);

CREATE UNIQUE INDEX IF NOT EXISTS float_account_state_singleton
  ON float_account_state ((true));
