-- S65 step 4 of 4: ledger row bank account snapshot.
--
-- Each allocation_owner_share / allocation_manager_fee ledger row snapshots
-- the bank account it's destined for at write time. autoPayouts then groups
-- positive-balance rows by (user_id, bank_account_id) to produce one
-- disbursement per user/bank pair on Friday — collapsing multiple properties
-- routed to the same bank account into a single ACH.
--
-- Snapshot semantics (vs. lookup-at-payout-time): if a landlord re-points a
-- property to a new bank account later, already-allocated funds stay routed
-- to the bank that was configured at the moment of allocation.
--
-- NULL is valid:
--   - withdrawal_auto entries written before this column existed (none in prod)
--   - allocation rows where the property had no bank assigned at write time
--   - manager_fee rows where the manager had no default bank set
-- autoPayouts skips NULL rows; they accumulate as user-visible balance but
-- don't drive a payout until the bank assignment is corrected.
--
-- Idempotency: existing ux_user_balance_ledger_idempotent unique index
-- (from S64 step 2) is unaffected — it keys on (reference_id, reference_type, type)
-- and bank_account_id is incidental to that uniqueness.

ALTER TABLE user_balance_ledger
  ADD COLUMN bank_account_id UUID
  REFERENCES user_bank_accounts(id);

CREATE INDEX idx_user_balance_ledger_bank_account
  ON user_balance_ledger(bank_account_id)
  WHERE bank_account_id IS NOT NULL;
