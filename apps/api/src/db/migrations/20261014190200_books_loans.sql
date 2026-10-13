-- 10/12 (Nic) — GAM BOOKS: THE LOAN REGISTER
--
-- Nic, 10/12: loans and mortgages are part of this build — "principal /
-- interest / escrow per payment". A landlord's mortgage payment is not one
-- expense: part of it pays the loan down (a liability, not a cost), part is
-- interest (an expense), and part goes to escrow (money the lender holds to
-- pay the property tax and insurance — still the landlord's money).
--
--   books_loans          one loan: the lender, the property it is on (or none:
--                        a company loan), what was borrowed and when, the
--                        yearly rate, the regular payment and its escrow part.
--                        How it reaches the books (services/ledgerProjectors/
--                        loansAssets.ts, source 'loan'):
--                          made on or after the books start date: the money it
--                            put somewhere (funded_to — a bank account, or
--                            straight to the seller of a property or of
--                            equipment) against the loan's own account;
--                          made before it: what was still owed on the books
--                            start date (opening_balance) and the escrow the
--                            lender held that day (opening_escrow), against
--                            opening balance equity.
--                        Each loan has its own sub-account under Mortgage
--                        payable (books_account_map kind 'loan').
--   books_loan_payments  one payment: the day, the amount and its three parts
--                        (principal + interest + escrow = amount, to the cent),
--                        where the money came from (a bank account, a credit
--                        card, the owner personally), and — when it was paid
--                        out of a linked bank — the bank line it is (matched
--                        from the Bank page, or typed first and matched when
--                        the line arrives). Posted on its day (source
--                        'loan_payment'): Dr the loan (principal), Dr Mortgage
--                        and loan interest (interest), Dr Escrow held by your
--                        lender (escrow), Cr where the money came from.
--
-- Money out is one record (Nic, L5): a loan payment IS the record of that
-- money; the bank line that shows it leaving matches it and never makes an
-- expense of its own (services/booksVendorsLoans matchLoanPaymentForBankLine,
-- which the Bank page's filing calls). A loan's funding deposit matches the
-- loan the same way.
--
-- Keep-everything: neither is ever deleted. A loan or payment entered by
-- mistake is voided (with who, when and why) and its postings are taken back.
-- Both carry the change journal (audit_row_change) and the ledger capture.
--
-- Expand-only; new tables. No backfill needed.
-- Safe drop: both tables (after their captures: DROP TRIGGER ledger_capture_*
-- and the capture functions), the guard functions.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS books_loans (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id                 uuid REFERENCES landlords(id),
  business_id                 uuid REFERENCES businesses(id),
  property_id                 uuid REFERENCES properties(id),
  vendor_id                   uuid REFERENCES books_vendors(id),
  name                        text NOT NULL,
  lender_name                 text NOT NULL,
  original_amount             numeric(12,2) NOT NULL,
  annual_rate                 numeric(7,4) NOT NULL DEFAULT 0,
  start_date                  date NOT NULL,
  term_months                 integer,
  payment_amount              numeric(12,2),
  escrow_amount               numeric(12,2) NOT NULL DEFAULT 0,
  payment_day                 smallint,
  funded_to                   text,
  funded_bank_connection_id   uuid REFERENCES bank_connections(id),
  funded_bank_transaction_id  uuid REFERENCES bank_transactions(id),
  opening_balance             numeric(12,2),
  opening_escrow              numeric(12,2),
  notes                       text,
  created_by                  uuid REFERENCES users(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  voided_at                   timestamptz,
  voided_by                   uuid REFERENCES users(id),
  void_reason                 text,
  CONSTRAINT books_loans_one_owner CHECK (num_nonnulls(landlord_id, business_id) = 1),
  CONSTRAINT books_loans_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT books_loans_lender_check CHECK (length(btrim(lender_name)) BETWEEN 1 AND 200),
  CONSTRAINT books_loans_amount_check CHECK (original_amount > 0),
  CONSTRAINT books_loans_rate_check CHECK (annual_rate >= 0 AND annual_rate < 100),
  CONSTRAINT books_loans_term_check CHECK (term_months IS NULL OR term_months BETWEEN 1 AND 600),
  CONSTRAINT books_loans_payment_check CHECK (payment_amount IS NULL OR payment_amount > 0),
  CONSTRAINT books_loans_escrow_check CHECK (escrow_amount >= 0 AND (payment_amount IS NULL OR escrow_amount <= payment_amount)),
  CONSTRAINT books_loans_payment_day_check CHECK (payment_day IS NULL OR payment_day BETWEEN 1 AND 31),
  CONSTRAINT books_loans_funded_to_check CHECK (funded_to IS NULL OR funded_to IN ('bank', 'property', 'equipment')),
  CONSTRAINT books_loans_funded_bank_is_bank CHECK (funded_bank_connection_id IS NULL OR funded_to = 'bank'),
  CONSTRAINT books_loans_funding_line_is_bank CHECK (funded_bank_transaction_id IS NULL OR funded_to = 'bank'),
  CONSTRAINT books_loans_opening_check CHECK ((opening_balance IS NULL OR opening_balance >= 0)
                                              AND (opening_escrow IS NULL OR opening_escrow >= 0)),
  CONSTRAINT books_loans_void_is_stamped CHECK ((voided_by IS NULL AND void_reason IS NULL) OR voided_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS books_loans_landlord ON books_loans (landlord_id) WHERE landlord_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS books_loans_business ON books_loans (business_id) WHERE business_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS books_loans_one_funding_line
  ON books_loans (funded_bank_transaction_id) WHERE funded_bank_transaction_id IS NOT NULL AND voided_at IS NULL;

COMMENT ON TABLE books_loans IS
  '10/12 (Nic): the loan register — lender, property, what was borrowed and when, rate, regular payment and its escrow part. Posts the money it put on the books (or what was owed on the books start date) to its own sub-account under Mortgage payable. Never deleted; voided.';
COMMENT ON COLUMN books_loans.funded_to IS
  '10/12: for a loan made on or after the books start, where the money went — bank (funded_bank_connection_id), or straight to the seller of a property / of equipment (BOOKS_LOAN_FUNDED_TO).';
COMMENT ON COLUMN books_loans.opening_balance IS
  '10/12: for a loan made before the books start, what was still owed on the books start date (from the lender''s statement); opening_escrow the escrow the lender held that day.';
COMMENT ON COLUMN books_loans.funded_bank_transaction_id IS
  '10/12: the bank line the loan''s money arrived as, when the Bank page matched it to the loan (never filed as income).';

CREATE TABLE IF NOT EXISTS books_loan_payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id              uuid NOT NULL REFERENCES books_loans(id),
  landlord_id          uuid REFERENCES landlords(id),
  business_id          uuid REFERENCES businesses(id),
  paid_on              date NOT NULL,
  amount               numeric(12,2) NOT NULL,
  principal            numeric(12,2) NOT NULL DEFAULT 0,
  interest             numeric(12,2) NOT NULL DEFAULT 0,
  escrow               numeric(12,2) NOT NULL DEFAULT 0,
  method               text NOT NULL,
  bank_connection_id   uuid REFERENCES bank_connections(id),
  bank_transaction_id  uuid REFERENCES bank_transactions(id),
  source               text NOT NULL DEFAULT 'entered',
  memo                 text,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  voided_at            timestamptz,
  voided_by            uuid REFERENCES users(id),
  void_reason          text,
  CONSTRAINT books_loan_payments_one_owner CHECK (num_nonnulls(landlord_id, business_id) = 1),
  CONSTRAINT books_loan_payments_amount_check CHECK (amount > 0),
  CONSTRAINT books_loan_payments_parts_check CHECK (principal >= 0 AND interest >= 0 AND escrow >= 0),
  CONSTRAINT books_loan_payments_parts_add_up CHECK (principal + interest + escrow = amount),
  CONSTRAINT books_loan_payments_method_check CHECK (method IN ('bank', 'card', 'owner_paid')),
  CONSTRAINT books_loan_payments_bank_is_bank CHECK (bank_connection_id IS NULL OR method = 'bank'),
  CONSTRAINT books_loan_payments_line_is_bank CHECK (bank_transaction_id IS NULL OR method = 'bank'),
  CONSTRAINT books_loan_payments_source_check CHECK (source IN ('entered', 'bank_line')),
  CONSTRAINT books_loan_payments_line_names_line CHECK (source <> 'bank_line' OR bank_transaction_id IS NOT NULL),
  CONSTRAINT books_loan_payments_void_is_stamped CHECK ((voided_by IS NULL AND void_reason IS NULL) OR voided_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS books_loan_payments_loan ON books_loan_payments (loan_id, paid_on);
CREATE INDEX IF NOT EXISTS books_loan_payments_landlord_day ON books_loan_payments (landlord_id, paid_on) WHERE landlord_id IS NOT NULL;
-- One live loan payment per bank line (a line taken back and matched again
-- leaves the voided one beside it).
CREATE UNIQUE INDEX IF NOT EXISTS books_loan_payments_one_per_line
  ON books_loan_payments (bank_transaction_id) WHERE bank_transaction_id IS NOT NULL AND voided_at IS NULL;

COMMENT ON TABLE books_loan_payments IS
  '10/12 (Nic): one loan payment split into principal (the loan goes down), interest (an expense) and escrow (money the lender holds), adding up to the payment. The record of that money out; a bank line matches it. Never deleted; voided.';
COMMENT ON COLUMN books_loan_payments.source IS
  '10/12: entered on the Loans page, or made from a bank line when the line was filed (taking that filing back voids it) — BOOKS_LOAN_PAYMENT_SOURCES.';

-- ── Guards: never deleted, a voided row is a record, the owner never moves ──
CREATE OR REPLACE FUNCTION books_loans_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A loan is never removed; void it instead.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'Loan % was voided: it is a record and does not change.', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.landlord_id IS DISTINCT FROM OLD.landlord_id OR NEW.business_id IS DISTINCT FROM OLD.business_id THEN
    RAISE EXCEPTION 'A loan''s company never changes.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS books_loans_guard ON books_loans;
CREATE TRIGGER books_loans_guard BEFORE UPDATE OR DELETE ON books_loans
  FOR EACH ROW EXECUTE FUNCTION books_loans_guard();

CREATE OR REPLACE FUNCTION books_loan_payments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  loan record;
  line record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A loan payment is never removed; void it instead.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'Loan payment % was voided: it is a record and does not change.', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.loan_id IS DISTINCT FROM OLD.loan_id OR NEW.landlord_id IS DISTINCT FROM OLD.landlord_id
       OR NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.source IS DISTINCT FROM OLD.source THEN
      RAISE EXCEPTION 'A loan payment''s loan, company and source never change; void it and record another.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT l.landlord_id, l.business_id, l.voided_at INTO loan FROM books_loans l WHERE l.id = NEW.loan_id;
  IF loan.landlord_id IS DISTINCT FROM NEW.landlord_id OR loan.business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'A loan payment belongs to its loan''s company.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.voided_at IS NULL AND loan.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'That loan was voided; it takes no payments.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.bank_transaction_id IS NOT NULL AND NEW.voided_at IS NULL
     AND (TG_OP = 'INSERT' OR NEW.bank_transaction_id IS DISTINCT FROM OLD.bank_transaction_id) THEN
    SELECT bt.amount, bt.landlord_id INTO line FROM bank_transactions bt WHERE bt.id = NEW.bank_transaction_id;
    IF line.landlord_id IS DISTINCT FROM NEW.landlord_id THEN
      RAISE EXCEPTION 'That bank line belongs to another company.' USING ERRCODE = 'check_violation';
    END IF;
    IF line.amount >= 0 THEN
      RAISE EXCEPTION 'That bank line is money coming in; a loan payment is money going out.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.amount > abs(line.amount) THEN
      RAISE EXCEPTION 'The loan payment (%) is more than the bank line (%).', NEW.amount, abs(line.amount)
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS books_loan_payments_guard ON books_loan_payments;
CREATE TRIGGER books_loan_payments_guard BEFORE INSERT OR UPDATE OR DELETE ON books_loan_payments
  FOR EACH ROW EXECUTE FUNCTION books_loan_payments_guard();

-- ── The change journal (every money table keeps its history) ────────────────
DROP TRIGGER IF EXISTS audit_books_loans ON books_loans;
CREATE TRIGGER audit_books_loans AFTER DELETE OR UPDATE ON books_loans
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
DROP TRIGGER IF EXISTS audit_books_loan_payments ON books_loan_payments;
CREATE TRIGGER audit_books_loan_payments AFTER DELETE OR UPDATE ON books_loan_payments
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- ── The ledger capture (LEDGER_CAPTURE_COLUMNS in packages/shared) ──────────
-- A loan's change re-posts the loan and every payment on it (each payment
-- carries the loan's property, name and company).
SELECT ledger_install_capture('books_loans',
  ARRAY['landlord_id', 'business_id', 'property_id', 'name', 'original_amount', 'start_date',
        'funded_to', 'funded_bank_connection_id', 'opening_balance', 'opening_escrow', 'voided_at'],
  $k$SELECT 'loan'::text, r.id::text, COALESCE(r.landlord_id, r.business_id)
      UNION ALL SELECT 'loan_payment', p.id::text, COALESCE(r.landlord_id, r.business_id)
                  FROM books_loan_payments p WHERE p.loan_id = r.id$k$);

SELECT ledger_install_capture('books_loan_payments',
  ARRAY['loan_id', 'landlord_id', 'business_id', 'paid_on', 'amount', 'principal', 'interest', 'escrow',
        'method', 'bank_connection_id', 'voided_at'],
  $k$SELECT 'loan_payment'::text, r.id::text, COALESCE(r.landlord_id, r.business_id)$k$);

-- Everything installed still matches its table.
SELECT ledger_check_capture();
