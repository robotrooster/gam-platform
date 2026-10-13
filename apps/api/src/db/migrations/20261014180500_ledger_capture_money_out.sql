-- 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P6: MONEY OUT POSTS ITSELF WITHIN THE MINUTE
--
--   Nic: "within a minute (+ nightly tie-out check)"
--
-- Design §7: a table's capture columns are the columns its projector reads, so
-- a change to any of them marks the source for posting. Phase P6 posts money
-- out and money filed in (design I1, I2, I4, and the bank-line matches of §12),
-- reading:
--
--   landlord_expenses          the expense: its category (category_id), who was
--                              paid (vendor_id), and the manager's-cut bill of
--                              a split (allocation_split_id — posted by the
--                              split, so the bill posts its payments only). A
--                              change marks the expense AND its payments
--                              (each payment's cash line carries the
--                              expense's category).
--   landlord_expense_payments  NEW: each payment — when, how much, how, the
--                              bank line that paid it.
--   landlord_other_income      its category (category_id).
--   bank_transactions          what a money-out line was matched to
--                              (matched_kind and the record it names). A
--                              change marks the line's own match posting, the
--                              payments that name it and the other income
--                              filed from it (they read the line's bank and day).
--
-- Columns are APPENDED to each list, in the same order as LEDGER_CAPTURE_COLUMNS
-- in packages/shared/src/booksLedger.ts (services/ledgerCoverage.test.ts holds
-- the trigger lists and the shared list equal).
-- Re-installing a capture replaces its three trigger bodies only, and a new
-- table's three triggers are created (ledger_install_capture, 20261013200600):
-- no table lock beyond a write's on the existing tables.
-- Expand-only; safe to apply before the code ships (the ledger only reads what
-- the drain posts). No backfill needed: the next rebuild reads every row.
-- Safe drop: re-install the three earlier captures with their earlier lists
-- (20261013200600; bank_transactions as 20261014170000) and drop the
-- ledger_capture_* triggers and functions of landlord_expense_payments.

SET LOCAL lock_timeout = '10s';

SELECT ledger_install_capture('landlord_expenses',
  ARRAY['landlord_id', 'property_id', 'unit_id', 'category', 'amount', 'expense_date', 'is_common', 'allocate_per_unit',
        'status', 'voided_at', 'utility_type', 'vendor', 'bank_transaction_id',
        'category_id', 'vendor_id', 'allocation_split_id'],
  $k$SELECT 'expense'::text, r.id::text, r.landlord_id
      UNION ALL SELECT 'expense_payment', p.id::text, p.landlord_id FROM landlord_expense_payments p WHERE p.expense_id = r.id$k$);

SELECT ledger_install_capture('landlord_expense_payments',
  ARRAY['expense_id', 'landlord_id', 'paid_on', 'amount', 'method', 'bank_connection_id', 'bank_transaction_id', 'voided_at'],
  $k$SELECT 'expense_payment'::text, r.id::text, r.landlord_id$k$);

SELECT ledger_install_capture('landlord_other_income',
  ARRAY['landlord_id', 'property_id', 'unit_id', 'category', 'amount', 'income_date', 'is_common', 'status', 'voided_at',
        'bank_transaction_id', 'category_id'],
  $k$SELECT 'other_income'::text, r.id::text, r.landlord_id$k$);

SELECT ledger_install_capture('bank_transactions',
  ARRAY['bank_connection_id', 'landlord_id', 'posted_date', 'amount', 'status', 'matched_payment_id',
        'matched_disbursement_id', 'expense_id', 'landlord_other_income_id', 'auto_settle_undo',
        'matched_kind', 'matched_gam_debit_id', 'matched_pos_refund_id', 'matched_refund_part_id',
        'matched_transfer_line_id'],
  $k$SELECT 'bank_match'::text, r.id::text, r.landlord_id
      UNION ALL SELECT 'disbursement', r.matched_disbursement_id::text, r.landlord_id
      UNION ALL SELECT 'other_income', r.landlord_other_income_id::text, r.landlord_id
      UNION ALL SELECT 'expense_payment', p.id::text, p.landlord_id FROM landlord_expense_payments p WHERE p.bank_transaction_id = r.id
      UNION ALL SELECT 'other_income', o.id::text, o.landlord_id FROM landlord_other_income o WHERE o.bank_transaction_id = r.id$k$);

-- ledger_posting_lines.expense_kind (left without a CHECK by P3 "until P6"):
-- the TYPE of account a money-out line's expense charges to — derived from the
-- category, never chosen (Nic L5: no forced kinds; MONEY_OUT_LINE_KINDS).
-- Reports count a cash line toward expenses only when it is 'expense'.
ALTER TABLE ledger_posting_lines DROP CONSTRAINT IF EXISTS ledger_posting_lines_expense_kind_check;
ALTER TABLE ledger_posting_lines ADD CONSTRAINT ledger_posting_lines_expense_kind_check
  CHECK (expense_kind IS NULL OR expense_kind IN ('asset', 'liability', 'equity', 'income', 'expense'));

-- ledger_postings.posting_kind 'bank_clear' (LEDGER_POSTING_KINDS): an expense
-- payment the bank line cleared on a later day than it was made — a check, or
-- a bank payment recorded before its line posted: Dr Outstanding checks / Cr
-- the bank, on the bank's day. ADDED to the CHECK as it stands (read from its
-- definition), so a kind another phase adds is kept whatever order they run in.
DO $widen$
DECLARE
  cur  text[];
  want text[];
BEGIN
  SELECT array_agg(m[1] ORDER BY ord) INTO cur
    FROM pg_constraint c
    CROSS JOIN LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') WITH ORDINALITY AS x(m, ord)
   WHERE c.conrelid = 'ledger_postings'::regclass AND c.conname = 'ledger_postings_kind_check';
  IF cur IS NULL THEN
    RAISE EXCEPTION 'ledger_postings_kind_check is missing';
  END IF;
  SELECT array_agg(v ORDER BY first_ord) INTO want FROM (
    SELECT v, min(ord) AS first_ord
      FROM unnest(cur || ARRAY['bank_clear']) WITH ORDINALITY AS u(v, ord)
     GROUP BY v) s;
  IF want <> cur THEN
    ALTER TABLE ledger_postings DROP CONSTRAINT ledger_postings_kind_check;
    EXECUTE format('ALTER TABLE ledger_postings ADD CONSTRAINT ledger_postings_kind_check CHECK (posting_kind IN (%s))',
                   (SELECT string_agg(quote_literal(v), ', ' ORDER BY o) FROM unnest(want) WITH ORDINALITY AS w(v, o)));
  END IF;
END $widen$;

-- Everything installed matches its table.
SELECT ledger_check_capture();
