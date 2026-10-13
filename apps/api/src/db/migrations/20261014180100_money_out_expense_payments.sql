-- 10/12 (Nic) — GAM BOOKS, PHASE P6: MONEY OUT IS ONE RECORD — THE EXPENSE AND ITS PAYMENTS
--
-- Nic, 10/12 (L5): money out is ONE record, the Expense. A bill is an unpaid
-- expense; filing a bank line creates or matches an expense; cash that never
-- touched the bank is logged by hand and never has to match a bank line.
-- (gam-ledger-design-2026-10-12 §6 I, §12 — "M6", with no expense kinds: the
-- category's account says what the money was, migration 20261014180000.)
--
--   landlord_expenses gains what a bill needs:
--     vendor_id        who was paid, from the one list of everyone the company
--                      pays (books_vendors). The text `vendor` stays for a
--                      payee who is not on the list.
--     bill_number      the vendor's invoice number
--     due_date         when an unpaid bill is due
--     payments_tracked TRUE when the code that writes its own payments wrote
--                      the row; FALSE (a writer from before 10/12) and the
--                      AFTER INSERT trigger below writes the one payment the
--                      old writers always meant ("logged = paid").
--     maintenance_request_id  the repair a bill is for (Nic L6) — so the
--                      repair's cost is never counted twice
--     work_trade_extra_hours_id  work-trade extra hours paid as a contractor
--                      payment from GAM Books (1099)
--     allocation_split_id  Nic L18: the manager's cut GAM held too little to
--                      pay — a real unpaid bill the landlord owes the manager.
--                      Its cost is posted by the split itself (the ledger's
--                      'allocation' posting), so this bill's own posting is its
--                      payments alone.
--     migrated_from_table / migrated_from_id  where a row moved from (the old
--                      Books Bills and Transactions, migration 20261014180300)
--   landlord_expense_payments  every payment toward an expense: when, how
--                      much, how (LANDLORD_EXPENSE_PAYMENT_METHODS), and the
--                      bank line that paid it. Paid / partly paid / unpaid is
--                      worked out from these (v_expense_balance), never stored.
--                      One bank line may pay several expenses; the live
--                      payments naming a line never add up to more than the
--                      line (a deferred constraint trigger), nor an expense's
--                      payments to more than the expense.
--   v_expense_balance  each live expense: amount, paid, unpaid, pay state.
--
-- THE MIGRATION WINDOW (migrations reach production before the code). Every
-- expense logged before today was paid in full the day it was logged — that
-- is what the old screens meant. The backfill writes that payment ('migrated'):
-- out of the bank line that filed it when one did, else "paid, how not
-- recorded" ('other', to classify). Until the new code ships, the old writers
-- still insert expenses with payments_tracked = FALSE; the AFTER INSERT
-- trigger writes the same payment for each (and an AFTER UPDATE trigger keeps
-- it in step when the old Expenses edit corrects the amount or the day), and
-- when the old bank-feed filing
-- then points its bank line at the expense, the second trigger moves that
-- payment onto the line. New code always inserts payments_tracked = TRUE and
-- writes its own payments, so neither trigger ever has to be dropped. A voided
-- expense voids its live payments with it (the third trigger), whoever voids it.
--
-- Money table: the change-journal trigger (audit_landlord_expense_payments)
-- from the start (CLAUDE.md, 10/12). Its ledger capture is migration
-- 20261014180500.
-- Expand-only; safe before the code ships.
-- Backfill: one 'migrated' payment per live expense (production on 10/12: 0
-- expenses). Idempotent.
-- Safe drop: the triggers and functions below, v_expense_balance,
-- landlord_expense_payments, the new landlord_expenses columns.

SET LOCAL lock_timeout = '10s';

ALTER TABLE landlord_expenses
  ADD COLUMN IF NOT EXISTS vendor_id                 uuid REFERENCES books_vendors(id),
  ADD COLUMN IF NOT EXISTS bill_number               text,
  ADD COLUMN IF NOT EXISTS due_date                  date,
  ADD COLUMN IF NOT EXISTS payments_tracked          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS maintenance_request_id    uuid REFERENCES maintenance_requests(id),
  ADD COLUMN IF NOT EXISTS work_trade_extra_hours_id uuid REFERENCES work_trade_extra_hours(id),
  ADD COLUMN IF NOT EXISTS allocation_split_id       uuid REFERENCES allocation_splits(id),
  ADD COLUMN IF NOT EXISTS migrated_from_table       text,
  ADD COLUMN IF NOT EXISTS migrated_from_id          uuid;

ALTER TABLE landlord_expenses DROP CONSTRAINT IF EXISTS landlord_expenses_migrated_from_check;
ALTER TABLE landlord_expenses ADD CONSTRAINT landlord_expenses_migrated_from_check
  CHECK ((migrated_from_table IS NULL) = (migrated_from_id IS NULL)
         AND (migrated_from_table IS NULL OR migrated_from_table IN ('books_bills', 'books_transactions')));
ALTER TABLE landlord_expenses DROP CONSTRAINT IF EXISTS landlord_expenses_bill_number_check;
ALTER TABLE landlord_expenses ADD CONSTRAINT landlord_expenses_bill_number_check
  CHECK (bill_number IS NULL OR length(bill_number) <= 100);

-- One live bill per repair, per work-trade record, per split; one row per old
-- Books record moved.
CREATE UNIQUE INDEX IF NOT EXISTS landlord_expenses_one_per_repair
  ON landlord_expenses (maintenance_request_id) WHERE maintenance_request_id IS NOT NULL AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS landlord_expenses_one_per_work_trade_hours
  ON landlord_expenses (work_trade_extra_hours_id) WHERE work_trade_extra_hours_id IS NOT NULL AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS landlord_expenses_one_per_split
  ON landlord_expenses (allocation_split_id) WHERE allocation_split_id IS NOT NULL AND status = 'active';
-- (One LIVE row per old record: 10/12 review — an old transaction whose type
-- the old page flipped, or that it removed, voids the row it moved to, and the
-- move may then make another; migration 20261014180300.)
CREATE UNIQUE INDEX IF NOT EXISTS landlord_expenses_migrated_once
  ON landlord_expenses (migrated_from_table, migrated_from_id) WHERE migrated_from_table IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS landlord_expenses_vendor ON landlord_expenses (vendor_id) WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS landlord_expenses_due ON landlord_expenses (landlord_id, due_date) WHERE status = 'active';

COMMENT ON COLUMN landlord_expenses.payments_tracked IS
  '10/12 (Nic, L5): TRUE = written by code that records its own payments (landlord_expense_payments). FALSE = an older writer; the AFTER INSERT trigger records it as paid in full that day, as the old screens meant.';
COMMENT ON COLUMN landlord_expenses.allocation_split_id IS
  '10/12 (Nic, L18): the manager''s cut GAM held too little to pay — the unpaid bill the landlord owes the manager. Its cost posts from the split (ledger ''allocation''); the bill posts its payments only.';

-- ── The payments ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS landlord_expense_payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id           uuid NOT NULL REFERENCES landlord_expenses(id),
  landlord_id          uuid NOT NULL REFERENCES landlords(id),
  paid_on              date NOT NULL,
  amount               numeric(12,2) NOT NULL,
  method               text NOT NULL,
  bank_connection_id   uuid REFERENCES bank_connections(id),
  bank_transaction_id  uuid REFERENCES bank_transactions(id),
  source               text NOT NULL,
  memo                 text,
  voided_at            timestamptz,
  voided_by            uuid REFERENCES users(id),
  void_reason          text,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT landlord_expense_payments_amount_check CHECK (amount > 0),
  CONSTRAINT landlord_expense_payments_method_check CHECK (method IN ('bank', 'check', 'card', 'cash', 'owner_paid', 'other')),
  CONSTRAINT landlord_expense_payments_source_check CHECK (source IN ('payment', 'bank_match', 'migrated')),
  -- A bank line pays only out of the bank (a transfer or a check that cleared).
  CONSTRAINT landlord_expense_payments_line_is_bank CHECK (bank_transaction_id IS NULL OR method IN ('bank', 'check')),
  -- What a bank match made names its line.
  CONSTRAINT landlord_expense_payments_match_names_line CHECK (source <> 'bank_match' OR bank_transaction_id IS NOT NULL),
  CONSTRAINT landlord_expense_payments_void_is_stamped CHECK (voided_by IS NULL OR voided_at IS NOT NULL)
);

-- One live payment per (line, expense): a line that pays two bills names each
-- once; a match undone and made again leaves the undone one voided beside it.
CREATE UNIQUE INDEX IF NOT EXISTS landlord_expense_payments_line_expense
  ON landlord_expense_payments (bank_transaction_id, expense_id) WHERE bank_transaction_id IS NOT NULL AND voided_at IS NULL;
CREATE INDEX IF NOT EXISTS landlord_expense_payments_expense ON landlord_expense_payments (expense_id);
CREATE INDEX IF NOT EXISTS landlord_expense_payments_line ON landlord_expense_payments (bank_transaction_id) WHERE bank_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS landlord_expense_payments_landlord_day ON landlord_expense_payments (landlord_id, paid_on);

COMMENT ON TABLE landlord_expense_payments IS
  '10/12 (Nic, L5): every payment toward an expense — when, how much, how, and the bank line that paid it. An expense''s paid / unpaid state is worked out from these (v_expense_balance). Never deleted; a payment taken back is voided.';

DROP TRIGGER IF EXISTS audit_landlord_expense_payments ON landlord_expense_payments;
CREATE TRIGGER audit_landlord_expense_payments AFTER DELETE OR UPDATE ON landlord_expense_payments
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- A payment belongs to its expense and its company for good, and a voided one
-- is a record: it never changes again and is never removed.
CREATE OR REPLACE FUNCTION landlord_expense_payments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A payment is never removed; void it instead.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'Payment % was voided: it is a record and does not change.', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.expense_id IS DISTINCT FROM OLD.expense_id OR NEW.landlord_id IS DISTINCT FROM OLD.landlord_id
     OR NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION 'A payment''s expense, company and source never change; void it and record another.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS landlord_expense_payments_guard ON landlord_expense_payments;
CREATE TRIGGER landlord_expense_payments_guard BEFORE UPDATE OR DELETE ON landlord_expense_payments
  FOR EACH ROW EXECUTE FUNCTION landlord_expense_payments_guard();

-- The sums, checked at commit (a split or a re-match writes several rows):
--   the live payments naming one bank line never add up to more than the
--   line's money out, and only a money-out line pays anything;
--   an expense's live payments never add up to more than the expense;
--   a payment's company is its expense's.
CREATE OR REPLACE FUNCTION landlord_expense_payments_sums() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r          record;
  line_amt   numeric;
  line_owner uuid;
  paid       numeric;
  e          record;
BEGIN
  r := NEW;
  IF r.bank_transaction_id IS NOT NULL THEN
    SELECT bt.amount, bt.landlord_id INTO line_amt, line_owner FROM bank_transactions bt WHERE bt.id = r.bank_transaction_id;
    SELECT COALESCE(sum(p.amount), 0) INTO paid FROM landlord_expense_payments p
     WHERE p.bank_transaction_id = r.bank_transaction_id AND p.voided_at IS NULL;
    IF paid > 0 AND line_amt >= 0 THEN
      RAISE EXCEPTION 'That bank line is money coming in; only money going out pays an expense.' USING ERRCODE = 'check_violation';
    END IF;
    IF paid > abs(line_amt) THEN
      RAISE EXCEPTION 'The payments on that bank line (%) come to more than the line itself (%).', paid, abs(line_amt)
        USING ERRCODE = 'check_violation';
    END IF;
    IF line_owner IS DISTINCT FROM r.landlord_id THEN
      RAISE EXCEPTION 'That bank line belongs to another company.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT x.amount, x.landlord_id INTO e FROM landlord_expenses x WHERE x.id = r.expense_id;
  IF e.landlord_id IS DISTINCT FROM r.landlord_id THEN
    RAISE EXCEPTION 'A payment belongs to its expense''s company.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(p.amount), 0) INTO paid FROM landlord_expense_payments p
   WHERE p.expense_id = r.expense_id AND p.voided_at IS NULL;
  IF paid > e.amount THEN
    RAISE EXCEPTION 'The payments on that expense (%) come to more than the expense itself (%).', paid, e.amount
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS landlord_expense_payments_sums ON landlord_expense_payments;
CREATE CONSTRAINT TRIGGER landlord_expense_payments_sums
  AFTER INSERT OR UPDATE ON landlord_expense_payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION landlord_expense_payments_sums();

-- An expense's amount never drops below what has been paid on it.
CREATE OR REPLACE FUNCTION landlord_expenses_cover_payments() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  paid numeric;
BEGIN
  SELECT COALESCE(sum(p.amount), 0) INTO paid FROM landlord_expense_payments p
   WHERE p.expense_id = NEW.id AND p.voided_at IS NULL;
  IF NEW.status = 'active' AND paid > NEW.amount THEN
    RAISE EXCEPTION 'This expense has % paid on it; its amount cannot be less than that.', paid USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS landlord_expenses_cover_payments ON landlord_expenses;
CREATE CONSTRAINT TRIGGER landlord_expenses_cover_payments
  AFTER UPDATE OF amount, status ON landlord_expenses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION landlord_expenses_cover_payments();

-- ── The migration window: older writers mean "logged = paid" ────────────────
-- An expense inserted by a writer from before 10/12 (payments_tracked FALSE):
-- paid in full the day it was logged — out of its bank line when it is one
-- part of a split line, else how is not recorded ('other').
CREATE OR REPLACE FUNCTION landlord_expenses_legacy_payment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  conn uuid;
  day  date;
BEGIN
  IF NEW.bank_transaction_id IS NOT NULL THEN
    SELECT bt.bank_connection_id, bt.posted_date INTO conn, day FROM bank_transactions bt WHERE bt.id = NEW.bank_transaction_id;
  END IF;
  INSERT INTO landlord_expense_payments
    (expense_id, landlord_id, paid_on, amount, method, bank_connection_id, bank_transaction_id, source, memo, created_by)
  SELECT NEW.id, NEW.landlord_id, COALESCE(day, NEW.expense_date), NEW.amount,
         CASE WHEN NEW.bank_transaction_id IS NOT NULL THEN 'bank' ELSE 'other' END,
         conn, NEW.bank_transaction_id, 'migrated',
         'Logged as paid before payments were recorded', NEW.created_by
   WHERE NEW.amount > 0;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS landlord_expenses_legacy_payment ON landlord_expenses;
CREATE TRIGGER landlord_expenses_legacy_payment AFTER INSERT ON landlord_expenses
  FOR EACH ROW WHEN (NEW.payments_tracked = FALSE AND NEW.status = 'active')
  EXECUTE FUNCTION landlord_expenses_legacy_payment();

-- 10/12 review: and an older writer CORRECTING one (the deployed Expenses
-- edit changes amount and date on hand-logged expenses). "Logged = paid" holds
-- after the edit too: the expense's one live payment — the 'migrated' one,
-- for the whole old amount, not on a bank line — follows it, to the new amount
-- and, when it was dated the old day, to the new day (the new code's "one
-- payment follows" rule, updateLandlordExpense). Without it, lowering an
-- amount failed at commit (the payments came to more than the expense) and
-- raising one left a phantom unpaid remainder — a bill in Accounts payable.
-- A plain row trigger, so it runs before the deferred cover check. New code
-- writes payments_tracked = TRUE, and for a row the backfill or the triggers
-- above wrote it moves the payment itself first — the payment then no longer
-- equals the old amount, so this changes nothing twice.
CREATE OR REPLACE FUNCTION landlord_expenses_legacy_payment_follows() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  pay record;
  n   integer;
BEGIN
  SELECT count(*) INTO n FROM landlord_expense_payments p WHERE p.expense_id = NEW.id AND p.voided_at IS NULL;
  IF n <> 1 OR NEW.amount <= 0 THEN RETURN NULL; END IF;
  SELECT p.id, p.amount, p.paid_on INTO pay FROM landlord_expense_payments p
   WHERE p.expense_id = NEW.id AND p.voided_at IS NULL AND p.source = 'migrated'
     AND p.bank_transaction_id IS NULL AND p.amount = OLD.amount;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF pay.amount = NEW.amount AND NOT (pay.paid_on = OLD.expense_date AND OLD.expense_date IS DISTINCT FROM NEW.expense_date) THEN
    RETURN NULL;
  END IF;
  UPDATE landlord_expense_payments
     SET amount = NEW.amount,
         paid_on = CASE WHEN pay.paid_on = OLD.expense_date THEN NEW.expense_date ELSE pay.paid_on END,
         updated_at = now()
   WHERE id = pay.id;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS landlord_expenses_legacy_payment_follows ON landlord_expenses;
CREATE TRIGGER landlord_expenses_legacy_payment_follows AFTER UPDATE OF amount, expense_date ON landlord_expenses
  FOR EACH ROW WHEN (NEW.payments_tracked = FALSE AND NEW.status = 'active'
                     AND (NEW.amount IS DISTINCT FROM OLD.amount OR NEW.expense_date IS DISTINCT FROM OLD.expense_date))
  EXECUTE FUNCTION landlord_expenses_legacy_payment_follows();

-- The older bank-feed filing points its line at the expense AFTER inserting
-- it: the expense's not-yet-placed migrated payment moves onto that line.
CREATE OR REPLACE FUNCTION bank_transactions_legacy_expense_line() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE landlord_expense_payments p
     SET method = 'bank', bank_transaction_id = NEW.id, bank_connection_id = NEW.bank_connection_id,
         paid_on = NEW.posted_date, updated_at = now()
   WHERE p.expense_id = NEW.expense_id AND p.source = 'migrated' AND p.bank_transaction_id IS NULL
     AND p.voided_at IS NULL AND NEW.amount < 0;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS bank_transactions_legacy_expense_line ON bank_transactions;
CREATE TRIGGER bank_transactions_legacy_expense_line AFTER UPDATE OF expense_id ON bank_transactions
  FOR EACH ROW WHEN (NEW.expense_id IS NOT NULL AND NEW.expense_id IS DISTINCT FROM OLD.expense_id)
  EXECUTE FUNCTION bank_transactions_legacy_expense_line();

-- A voided expense takes its live payments with it (kept on record, voided).
CREATE OR REPLACE FUNCTION landlord_expenses_void_payments() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE landlord_expense_payments
     SET voided_at = COALESCE(NEW.voided_at, now()), void_reason = 'The expense was voided', updated_at = now()
   WHERE expense_id = NEW.id AND voided_at IS NULL;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS landlord_expenses_void_payments ON landlord_expenses;
CREATE TRIGGER landlord_expenses_void_payments AFTER UPDATE OF status ON landlord_expenses
  FOR EACH ROW WHEN (NEW.status = 'voided' AND OLD.status IS DISTINCT FROM 'voided')
  EXECUTE FUNCTION landlord_expenses_void_payments();

-- ── Paid, partly paid, unpaid ───────────────────────────────────────────────
CREATE OR REPLACE VIEW v_expense_balance AS
SELECT e.id AS expense_id, e.landlord_id, e.amount,
       COALESCE(p.paid, 0)::numeric(12,2) AS paid,
       (e.amount - COALESCE(p.paid, 0))::numeric(12,2) AS unpaid,
       p.last_paid_on,
       CASE WHEN COALESCE(p.paid, 0) <= 0 THEN 'unpaid'
            WHEN COALESCE(p.paid, 0) < e.amount THEN 'partial'
            ELSE 'paid' END AS pay_state
  FROM landlord_expenses e
  LEFT JOIN LATERAL (
    SELECT sum(x.amount) AS paid, max(x.paid_on) AS last_paid_on
      FROM landlord_expense_payments x WHERE x.expense_id = e.id AND x.voided_at IS NULL
  ) p ON TRUE
 WHERE e.status = 'active';

COMMENT ON VIEW v_expense_balance IS
  '10/12 (Nic, L5): each live expense''s paid and unpaid parts, from its payments (EXPENSE_PAY_STATES).';

-- ── Backfill: every live expense logged before today was paid that day ──────
INSERT INTO landlord_expense_payments
  (expense_id, landlord_id, paid_on, amount, method, bank_connection_id, bank_transaction_id, source, memo, created_by, created_at)
SELECT e.id, e.landlord_id, COALESCE(bt.posted_date, e.expense_date), e.amount,
       CASE WHEN bt.id IS NOT NULL AND bt.amount < 0 THEN 'bank' ELSE 'other' END,
       CASE WHEN bt.id IS NOT NULL AND bt.amount < 0 THEN bt.bank_connection_id END,
       CASE WHEN bt.id IS NOT NULL AND bt.amount < 0 THEN bt.id END,
       'migrated', 'Logged as paid before payments were recorded', e.created_by, e.created_at
  FROM landlord_expenses e
  LEFT JOIN LATERAL (
    SELECT b.id, b.bank_connection_id, b.posted_date, b.amount FROM bank_transactions b
     WHERE b.id = e.bank_transaction_id
        OR (e.bank_transaction_id IS NULL AND b.expense_id = e.id AND b.status = 'categorized')
     ORDER BY (b.id = e.bank_transaction_id) DESC, b.created_at, b.id LIMIT 1
  ) bt ON TRUE
 WHERE e.status = 'active' AND e.amount > 0
   AND NOT EXISTS (SELECT 1 FROM landlord_expense_payments x WHERE x.expense_id = e.id);
