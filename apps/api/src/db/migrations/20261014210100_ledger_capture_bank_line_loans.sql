-- 10/12 (Nic) — GAM BOOKS LEDGER: A LOAN MATCHED TO ITS BANK LINE POSTS ON THE BANK'S DAY, WITHIN THE MINUTE
--
--   Nic: "within a minute (+ nightly tie-out check)"
--
-- Design §7: a table's capture columns are the columns its projector reads.
-- The integrate step wires the Bank page to the loans (migration
-- 20261014210000): a money-out line can be a loan payment and a money-in line
-- a loan's money arriving. Their postings now read the bank line
-- (services/ledgerProjectors/loansAssets.ts):
--   'loan_payment'  a payment typed on one day whose bank line posted on
--                   another credits Outstanding checks (2015) on its own day
--                   and the line clears it on the bank's day — so it reads
--                   books_loan_payments.bank_transaction_id and that line's
--                   day and bank;
--   'loan'          a loan's money matched to the line it arrived as is in
--                   the bank on that line's day — so it reads
--                   books_loans.funded_bank_transaction_id and that line's day.
-- So:
--   books_loans          + funded_bank_transaction_id (APPENDED)
--   books_loan_payments  + bank_transaction_id (APPENDED)
--   bank_transactions    the same columns; a change now also marks the loan
--                        payments that name the line and the loan funded by it.
-- Columns are appended in the same order as LEDGER_CAPTURE_COLUMNS in
-- packages/shared/src/booksLedger.ts (services/ledgerCoverage.test.ts holds
-- the trigger lists and the shared list equal).
-- Re-installing a capture replaces its three trigger bodies only
-- (ledger_install_capture, 20261013200600): no table lock beyond a write's.
-- Expand-only; safe to apply before the code ships. No backfill needed: no
-- loan or loan payment names a bank line yet, and the next rebuild reads every
-- row.
-- Safe drop: re-install the three captures as 20261014190200 (books_loans,
-- books_loan_payments) and 20261014180500 (bank_transactions) left them.

SET LOCAL lock_timeout = '10s';

SELECT ledger_install_capture('books_loans',
  ARRAY['landlord_id', 'business_id', 'property_id', 'name', 'original_amount', 'start_date',
        'funded_to', 'funded_bank_connection_id', 'opening_balance', 'opening_escrow', 'voided_at',
        'funded_bank_transaction_id'],
  $k$SELECT 'loan'::text, r.id::text, COALESCE(r.landlord_id, r.business_id)
      UNION ALL SELECT 'loan_payment', p.id::text, COALESCE(r.landlord_id, r.business_id)
                  FROM books_loan_payments p WHERE p.loan_id = r.id$k$);

SELECT ledger_install_capture('books_loan_payments',
  ARRAY['loan_id', 'landlord_id', 'business_id', 'paid_on', 'amount', 'principal', 'interest', 'escrow',
        'method', 'bank_connection_id', 'voided_at',
        'bank_transaction_id'],
  $k$SELECT 'loan_payment'::text, r.id::text, COALESCE(r.landlord_id, r.business_id)$k$);

SELECT ledger_install_capture('bank_transactions',
  ARRAY['bank_connection_id', 'landlord_id', 'posted_date', 'amount', 'status', 'matched_payment_id',
        'matched_disbursement_id', 'expense_id', 'landlord_other_income_id', 'auto_settle_undo',
        'matched_kind', 'matched_gam_debit_id', 'matched_pos_refund_id', 'matched_refund_part_id',
        'matched_transfer_line_id'],
  $k$SELECT 'bank_match'::text, r.id::text, r.landlord_id
      UNION ALL SELECT 'disbursement', r.matched_disbursement_id::text, r.landlord_id
      UNION ALL SELECT 'other_income', r.landlord_other_income_id::text, r.landlord_id
      UNION ALL SELECT 'expense_payment', p.id::text, p.landlord_id FROM landlord_expense_payments p WHERE p.bank_transaction_id = r.id
      UNION ALL SELECT 'other_income', o.id::text, o.landlord_id FROM landlord_other_income o WHERE o.bank_transaction_id = r.id
      UNION ALL SELECT 'loan_payment', lp.id::text, lp.landlord_id FROM books_loan_payments lp WHERE lp.bank_transaction_id = r.id
      UNION ALL SELECT 'loan', lf.id::text, lf.landlord_id FROM books_loans lf WHERE lf.funded_bank_transaction_id = r.id$k$);

-- Everything installed still matches its table.
SELECT ledger_check_capture();
