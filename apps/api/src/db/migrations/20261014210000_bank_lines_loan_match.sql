-- 10/12 (Nic) — GAM BOOKS: A BANK LINE CAN BE A LOAN PAYMENT OR A LOAN'S MONEY ARRIVING
--
-- Nic, 10/12: loans and mortgages are in this build ("principal / interest /
-- escrow per payment"), and money out is ONE record (L5). A mortgage payment
-- leaving the bank is the loan payment the Loans page records — never an
-- expense of its own — and a loan's money arriving is the loan itself, never
-- income. The Bank page's "What did this pay?" panel now offers both, beside
-- the bills, checks, GAM's fee debit, refunds and transfers it already offers
-- (services/bankMoneyOut matchLineToRecord, which calls
-- services/booksVendorsLoans matchLoanPaymentForBankLine).
--
--   bank_transactions.matched_kind  gains (BANK_LINE_MATCH_KINDS):
--     loan_payment  money out that is a loan payment — the payment names the
--                   line (books_loan_payments.bank_transaction_id) and is what
--                   posts (ledger source 'loan_payment')
--     loan_funding  money in that is a loan's money arriving — the loan names
--                   the line (books_loans.funded_bank_transaction_id) and is
--                   what posts (ledger source 'loan')
-- Neither has a matched_*_id column of its own: the loan record names the
-- line, the same way an expense payment names it for 'expenses'. Undo (the
-- Bank page) voids a payment made from the line and unlinks one typed first
-- (unmatchLoanBankLine), and the line goes back to review.
--
-- Idempotent (drop the CHECK if present, add the full list), so it lands the
-- same whichever order it runs in beside 20261014180200.
-- Expand-only: every existing value still passes; safe before the code ships.
-- No backfill needed (nothing was matched to a loan before).
-- Safe drop: re-add the CHECK without the two values once no line carries them.

SET LOCAL lock_timeout = '10s';

ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_matched_kind_check;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_matched_kind_check
  CHECK (matched_kind IS NULL OR matched_kind IN
    ('expenses', 'gam_debit', 'pos_refund', 'refund_part', 'transfer', 'loan_payment', 'loan_funding'));

COMMENT ON COLUMN bank_transactions.matched_kind IS
  '10/12 (Nic, L5): what a bank line was matched to — money out: expenses (their payments name the line), GAM''s fee debit, a register refund or a refund check, a transfer between the company''s accounts, or a loan payment (the payment names the line); money in: a loan''s money arriving (the loan names the line). BANK_LINE_MATCH_KINDS. The line never makes a record of its own.';
