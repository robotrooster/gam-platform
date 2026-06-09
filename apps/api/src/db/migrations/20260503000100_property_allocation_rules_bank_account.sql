-- S65 step 2 of 4: link property → bank account.
--
-- Each property has at most one assigned bank account. Multiple properties
-- can share one bank account (e.g., several properties under the same LLC).
-- Property without an assigned bank account is valid; autoPayouts skips
-- ledger entries with NULL bank_account_id.
--
-- App-layer validation (FK can't express): the chosen bank_account.user_id
-- must equal the property's owner_user_id. Owners can only route to their
-- own catalog entries. Enforced in routes/properties.ts and routes/bankAccounts.ts.
--
-- Existing rows: NULL is correct. No backfill — landlord assigns per-property
-- via the property edit UI after creating bank accounts in the Banking page.

ALTER TABLE property_allocation_rules
  ADD COLUMN owner_bank_account_id UUID
  REFERENCES user_bank_accounts(id);

CREATE INDEX idx_property_allocation_rules_bank_account
  ON property_allocation_rules(owner_bank_account_id)
  WHERE owner_bank_account_id IS NOT NULL;
