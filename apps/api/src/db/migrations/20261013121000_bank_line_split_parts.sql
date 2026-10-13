-- 10/12 (Nic) — ONE BANK LINE, SEVERAL KINDS OF MONEY
--
--   "categories are separate. if a deposit is multiple sources it should be
--    split for record keeping"
--
-- Mountain View's $48.39 Square deposit of 10/1 is propane sales AND an
-- overnight stay, and the Bank page could only file it as ONE category. The
-- owner can now split a bank line into parts, each with its own category and
-- its own unit or property, the parts adding up to the bank's amount to the
-- cent (services/bankFeed splitTransaction). Money in splits into
-- landlord_other_income rows, money out into landlord_expenses rows — one row
-- per part — so every reader that already counts those rows (the P&L through
-- services/incomeBasis, the expense totals, the reports) counts each part in
-- its own category with no change.
--
-- bank_transaction_id says which bank line a part came from. A bank line
-- filed as ONE category keeps its existing link (bank_transactions.
-- landlord_other_income_id / expense_id, unchanged); a split line has both of
-- those NULL and its parts point at it from here. A part that is replaced
-- (the split was changed or undone) is voided, never deleted, and keeps
-- pointing at the line, so the line's whole filing history stays on file; the
-- single row a split replaces is stamped the same way when it is voided.
--
-- ON DELETE SET NULL: a bank line is never deleted in production (kept
-- forever); the clause only lets the test cleanup clear bank lines before the
-- money rows, the same as bank_transactions.landlord_other_income_id.
--
-- Safe to apply before the code ships: nullable, nothing reads or writes the
-- columns until it does.
-- No backfill needed: no line has been split yet, and single filings keep
-- their link on bank_transactions.
-- Safe drop: DROP INDEX idx_landlord_other_income_bank_txn,
-- idx_landlord_expenses_bank_txn; ALTER TABLE landlord_other_income DROP
-- COLUMN bank_transaction_id; ALTER TABLE landlord_expenses DROP COLUMN
-- bank_transaction_id.

ALTER TABLE landlord_other_income
  ADD COLUMN IF NOT EXISTS bank_transaction_id uuid REFERENCES bank_transactions(id) ON DELETE SET NULL;

ALTER TABLE landlord_expenses
  ADD COLUMN IF NOT EXISTS bank_transaction_id uuid REFERENCES bank_transactions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_landlord_other_income_bank_txn
  ON landlord_other_income (bank_transaction_id) WHERE bank_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_landlord_expenses_bank_txn
  ON landlord_expenses (bank_transaction_id) WHERE bank_transaction_id IS NOT NULL;
