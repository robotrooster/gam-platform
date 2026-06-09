-- S65 step 1 of 4: pivot user_bank_accounts from per-user-primary to per-property assignment.
--
-- S64 shipped this table with `is_primary` + a partial unique index assuming one
-- primary account per user. The product model is actually:
--   - bank accounts are a per-user catalog (user adds them, manages them, 1099s point at them)
--   - each property points at one bank account via property_allocation_rules.owner_bank_account_id
--   - multiple properties can share one bank account (e.g., several properties under one LLC)
--   - per-user "primary" is meaningless under this model
--
-- Also adds account_holder_type to support the LLC case: a single user with multiple
-- LLCs needs to label each catalog entry by the legal entity that receives the money,
-- distinct from the user's own personal name.
--
-- Safe drop: table is currently empty (no rows in dev or prod).

-- 1. Drop the partial unique index that depends on is_primary
DROP INDEX IF EXISTS ux_user_bank_accounts_primary;

-- 2. Drop is_primary
ALTER TABLE user_bank_accounts
  DROP COLUMN is_primary;

-- 3. Add account_holder_type
ALTER TABLE user_bank_accounts
  ADD COLUMN account_holder_type TEXT NOT NULL DEFAULT 'individual';

ALTER TABLE user_bank_accounts
  ADD CONSTRAINT user_bank_accounts_account_holder_type_check
  CHECK (account_holder_type IN ('individual', 'business'));
