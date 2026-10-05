-- S655 money plan M10 (Step 1), K-D. Expand-only: added columns and a pair
-- check that holds for every existing row (both new columns are NULL).
--
-- Nic (10/2): money GAM never handled files itself after the landlord files the
-- first deposit from that payer: money IN only, labeled, with one-click undo.
-- Never for a rent-channel payer (RENT_CHANNEL_PAYERS), a payer ever matched to
-- a tenant bill, or a deposit that equals any open bill.
ALTER TABLE landlord_merchant_rules
  ADD COLUMN IF NOT EXISTS last_direction text
    CONSTRAINT landlord_merchant_rules_last_direction_check
    CHECK (last_direction IS NULL OR last_direction IN ('in','out')),
  ADD COLUMN IF NOT EXISTS auto_file_income boolean NOT NULL DEFAULT true;
ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS auto_filed_rule_id uuid REFERENCES landlord_merchant_rules(id),
  ADD COLUMN IF NOT EXISTS auto_filed_at timestamptz;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_auto_filed_pair
  CHECK ((auto_filed_rule_id IS NULL) = (auto_filed_at IS NULL));
COMMENT ON COLUMN landlord_merchant_rules.last_direction IS
  'S655: whether the landlord last filed money IN or OUT from this payer. Auto-filing needs in.';
COMMENT ON COLUMN landlord_merchant_rules.auto_file_income IS
  'S655 (Nic): after the landlord files money IN from this payer once (last_direction = in), later deposits from the same payer file themselves as the same income, labeled, with one-click undo. Never for money out, a rent-channel payer (RENT_CHANNEL_PAYERS), a payer ever matched to a tenant bill, or a deposit that equals any open bill. Undo can switch this off for the payer.';
COMMENT ON COLUMN bank_transactions.auto_filed_rule_id IS
  'S655: the payer rule that filed this deposit by itself. Set with auto_filed_at; Undo clears both.';
