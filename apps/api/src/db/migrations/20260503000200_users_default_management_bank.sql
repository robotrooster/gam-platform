-- S65 step 3 of 4: manager fee default bank account.
--
-- When a property has owner ≠ manager, the allocation engine writes a separate
-- manager_fee ledger row to the manager. That row needs a bank_account_id to
-- route the Friday payout. Per-property manager_bank_account_id was rejected as
-- excess config burden — managers are typically single operators who collect
-- all management fees into one account.
--
-- Snapshot semantics: allocation engine reads this column at write time and
-- stamps the resulting bank_account_id onto the manager_fee ledger row. If
-- the manager later changes their default, already-allocated rows stay routed
-- to the bank that was configured at the moment of allocation.
--
-- App-layer validation (FK can't express): the chosen bank_account.user_id
-- must equal users.id. Enforced in the user-settings update path.
--
-- NULL is valid for non-manager users and for managers who haven't configured
-- one yet. autoPayouts skips ledger rows with NULL bank_account_id.

ALTER TABLE users
  ADD COLUMN default_management_payout_bank_account_id UUID
  REFERENCES user_bank_accounts(id);

CREATE INDEX idx_users_default_management_bank
  ON users(default_management_payout_bank_account_id)
  WHERE default_management_payout_bank_account_id IS NOT NULL;
