-- 16a Step 3 prep: user_bank_accounts table for external ACH destinations.
-- Manual entry only (no Plaid, no micro-deposit verification).
-- Account numbers stored AES-256 encrypted at app layer; last4 displayed in UI.
-- Decryption only happens server-side at payout-fire time (item 16).

CREATE TABLE user_bank_accounts (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname                 TEXT NOT NULL,
  account_holder_name      TEXT NOT NULL,
  account_type             TEXT NOT NULL,
  routing_number           TEXT NOT NULL,
  account_number_last4     TEXT NOT NULL,
  account_number_encrypted TEXT NOT NULL,
  is_primary               BOOLEAN NOT NULL DEFAULT false,
  status                   TEXT NOT NULL DEFAULT 'active',
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT user_bank_accounts_account_type_check
    CHECK (account_type IN ('checking', 'savings')),
  CONSTRAINT user_bank_accounts_status_check
    CHECK (status IN ('active', 'archived')),
  CONSTRAINT user_bank_accounts_routing_number_length_check
    CHECK (length(routing_number) = 9),
  CONSTRAINT user_bank_accounts_account_number_last4_length_check
    CHECK (length(account_number_last4) = 4)
);

-- Only one active primary per user
CREATE UNIQUE INDEX ux_user_bank_accounts_primary
  ON user_bank_accounts(user_id)
  WHERE is_primary = true AND status = 'active';

CREATE INDEX idx_user_bank_accounts_user_active
  ON user_bank_accounts(user_id) WHERE status = 'active';

CREATE TRIGGER trg_user_bank_accounts_updated_at
  BEFORE UPDATE ON user_bank_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Wire disbursements to the bank account it was sent to (audit trail)
ALTER TABLE disbursements
  ADD COLUMN bank_account_id UUID REFERENCES user_bank_accounts(id);

CREATE INDEX idx_disbursements_bank_account
  ON disbursements(bank_account_id) WHERE bank_account_id IS NOT NULL;
