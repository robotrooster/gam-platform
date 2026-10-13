-- 10/12 (Nic) — GAM BOOKS, PHASE P6: THE OLD BILLS AND TRANSACTIONS MOVE ONTO THE ONE RECORD
--
-- Money out is one record (Nic 10/12, L5): every dollar out is an expense and a
-- bill is an unpaid expense. GAM Books kept two records of its own beside the
-- landlord's Expenses — Bills (books_bills, with its payments
-- books_bill_payments) and Transactions (books_transactions, money in and out
-- typed by hand). Their pages retire for a landlord company; what they held
-- moves here (gam-ledger-design-2026-10-12 §12):
--
--   books_bills          → an expense (vendor, bill number, due date), and each
--                          payment toward it (books_bill_payments, oldest first,
--                          never more than the bill) → a 'migrated' payment
--   books_transactions   expense rows → an expense paid that day ('migrated');
--                        income rows  → other income (landlord_other_income)
--
-- How each was paid was never recorded, so the payments read "paid, how not
-- recorded" ('other') — to classify on the Expenses page. The category
-- (10/12 review): the company's category that charges to the account the row
-- was booked to (account_id) — preferring one whose key or name also matches
-- what the row said — else the category whose key or name matches what the row
-- said, else Other.
--
-- The originals stay exactly as they were, read only, each with a pointer to
-- where it went (migrated_expense_id / migrated_other_income_id, migrated_at),
-- and every moved row points back (migrated_from_table / migrated_from_id).
-- Nothing is dropped. A business's books (business_id) are not moved: the
-- business portal keeps its own Bills and Transactions until its books phase.
-- A transaction someone removed (deleted_at) stays where it is.
--
-- THE WINDOW (10/12 review). This runs before the code that retires the old
-- pages ships, and the deployed Books still writes them: it adds bills and
-- transactions, pays bills (amount_paid), edits and removes transactions. So
-- the move is a function, books_move_retired_rows(), run once here and again
-- by triggers whenever the old pages write a landlord company's row — the way
-- the contractors fold keeps up (20261014190000):
--   - a bill or transaction added: moved at once;
--   - a bill paid (amount_paid, or a books_bill_payments row): the payment
--     beyond what its expense already has from the bill becomes a 'migrated'
--     payment on that expense, dated the payment's day (else the day it was
--     paid off, else today), never more than the bill or the expense;
--   - a moved transaction corrected (amount, day, words, category, account):
--     its expense (and that expense's one payment) or its other income follows;
--     removed, or switched between income and expense: what it moved to is
--     voided (kept on record) and it moves again as what it is now.
-- Once the code ships the old pages refuse a landlord company's rows and the
-- triggers never fire for them again.
--
-- Production on 10/12: 0 bills, 0 transactions. The demo and test databases
-- have some. Idempotent (a row already moved is skipped).
-- Expand-only.
-- Safe drop: the triggers and functions, the pointer columns (the moved rows
-- stay; void them by hand if ever needed).

SET LOCAL lock_timeout = '10s';

ALTER TABLE books_bills
  ADD COLUMN IF NOT EXISTS migrated_expense_id uuid REFERENCES landlord_expenses(id),
  ADD COLUMN IF NOT EXISTS migrated_at         timestamptz;
ALTER TABLE books_transactions
  ADD COLUMN IF NOT EXISTS migrated_expense_id      uuid REFERENCES landlord_expenses(id),
  ADD COLUMN IF NOT EXISTS migrated_other_income_id uuid REFERENCES landlord_other_income(id),
  ADD COLUMN IF NOT EXISTS migrated_at              timestamptz;
ALTER TABLE landlord_other_income
  ADD COLUMN IF NOT EXISTS migrated_from_table text,
  ADD COLUMN IF NOT EXISTS migrated_from_id    uuid;
ALTER TABLE landlord_other_income DROP CONSTRAINT IF EXISTS landlord_other_income_migrated_from_check;
ALTER TABLE landlord_other_income ADD CONSTRAINT landlord_other_income_migrated_from_check
  CHECK ((migrated_from_table IS NULL) = (migrated_from_id IS NULL)
         AND (migrated_from_table IS NULL OR migrated_from_table = 'books_transactions'));
-- One LIVE row per old record (a row voided because the old page removed or
-- switched it stays beside the one it moved to next).
CREATE UNIQUE INDEX IF NOT EXISTS landlord_other_income_migrated_once
  ON landlord_other_income (migrated_from_table, migrated_from_id) WHERE migrated_from_table IS NOT NULL AND status = 'active';

COMMENT ON COLUMN books_bills.migrated_expense_id IS
  '10/12 (Nic, L5): the expense this bill became when money out became one record. The bill stays as it was, read only.';
COMMENT ON COLUMN books_transactions.migrated_expense_id IS
  '10/12 (Nic, L5): the expense this money-out transaction became. The transaction stays as it was, read only.';
COMMENT ON COLUMN books_transactions.migrated_other_income_id IS
  '10/12 (Nic, L5): the other income this money-in transaction became. The transaction stays as it was, read only.';

-- The company's category for a free-typed word: a seeded key or a name that
-- matches it, else the direction's Other.
CREATE OR REPLACE FUNCTION books_category_for_text(p_landlord uuid, p_direction text, p_text text) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT c.id FROM books_categories c
      WHERE c.landlord_id = p_landlord AND c.direction = p_direction AND c.archived_at IS NULL
        AND (c.system_key = lower(regexp_replace(btrim(COALESCE(p_text, '')), '[^A-Za-z0-9]+', '_', 'g'))
             OR lower(btrim(c.name)) = lower(btrim(COALESCE(p_text, ''))))
      ORDER BY (c.system_key IS NOT NULL) DESC, c.created_at LIMIT 1),
    (SELECT c.id FROM books_categories c
      WHERE c.landlord_id = p_landlord AND c.direction = p_direction AND c.system_key = 'other'))
$$;

-- 10/12 review: the company's category for an old row — the account it was
-- booked to first (a live category charging to that account on the row's day,
-- one whose key or name also matches the row's word before the rest, a seeded
-- one before one the company made), then the word (books_category_for_text).
CREATE OR REPLACE FUNCTION books_category_for_row(p_landlord uuid, p_direction text, p_text text, p_account uuid, p_day date)
RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT c.id FROM books_categories c
      WHERE p_account IS NOT NULL AND c.landlord_id = p_landlord AND c.direction = p_direction AND c.archived_at IS NULL
        AND books_category_account(c.id, COALESCE(p_day, CURRENT_DATE)) = p_account
      ORDER BY (c.system_key = lower(regexp_replace(btrim(COALESCE(p_text, '')), '[^A-Za-z0-9]+', '_', 'g'))
                OR lower(btrim(c.name)) = lower(btrim(COALESCE(p_text, '')))) DESC NULLS LAST,
               (c.system_key IS NOT NULL) DESC, c.created_at, c.id
      LIMIT 1),
    books_category_for_text(p_landlord, p_direction, p_text))
$$;

-- The word the older expense reports group by for a category: one of the old
-- fixed list's keys, else 'other'.
CREATE OR REPLACE FUNCTION books_legacy_expense_key(p_category uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT c.system_key FROM books_categories c
                    WHERE c.id = p_category
                      AND c.system_key IN ('maintenance', 'repairs', 'utilities', 'insurance', 'property_tax', 'management',
                                           'supplies', 'landscaping', 'professional', 'mortgage_interest', 'hoa',
                                           'advertising', 'lot_rent', 'bank_fees', 'other')), 'other')
$$;

-- ── The move ────────────────────────────────────────────────────────────────
-- Everything of the old pages not moved yet, for one company (or every one).
-- Idempotent. Returns how many rows it moved or paid.
CREATE OR REPLACE FUNCTION books_move_retired_rows(p_landlord uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  n integer := 0;
  k integer;
BEGIN
  PERFORM books_seed_categories(x.landlord_id)
     FROM (SELECT landlord_id FROM books_bills
            WHERE landlord_id IS NOT NULL AND migrated_expense_id IS NULL AND (p_landlord IS NULL OR landlord_id = p_landlord)
           UNION SELECT landlord_id FROM books_transactions
            WHERE landlord_id IS NOT NULL AND migrated_at IS NULL AND (p_landlord IS NULL OR landlord_id = p_landlord)) x;

  -- ── Bills → expenses ──────────────────────────────────────────────────────
  INSERT INTO landlord_expenses
    (landlord_id, category, category_id, amount, description, vendor, vendor_id, bill_number, expense_date, due_date,
     is_common, allocate_per_unit, status, payments_tracked, migrated_from_table, migrated_from_id, created_at, updated_at)
  SELECT b.landlord_id, books_legacy_expense_key(m.cat), m.cat, b.amount,
         concat_ws(' — ', NULLIF(btrim(b.description), ''), NULLIF(btrim(b.notes), '')),
         v.name, b.vendor_id, b.bill_number, b.date, b.due_date,
         FALSE, FALSE, 'active', TRUE, 'books_bills', b.id, COALESCE(b.created_at, now()), now()
    FROM books_bills b
    LEFT JOIN books_vendors v ON v.id = b.vendor_id
   CROSS JOIN LATERAL (SELECT books_category_for_row(b.landlord_id, 'expense', b.category, b.account_id, b.date) AS cat) m
   WHERE b.landlord_id IS NOT NULL AND (p_landlord IS NULL OR b.landlord_id = p_landlord)
     AND b.migrated_expense_id IS NULL AND b.amount > 0
     AND NOT EXISTS (SELECT 1 FROM landlord_expenses e
                      WHERE e.migrated_from_table = 'books_bills' AND e.migrated_from_id = b.id AND e.status = 'active');
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

  UPDATE books_bills b SET migrated_expense_id = e.id, migrated_at = now()
    FROM landlord_expenses e
   WHERE e.migrated_from_table = 'books_bills' AND e.migrated_from_id = b.id AND e.status = 'active'
     AND b.migrated_expense_id IS NULL AND (p_landlord IS NULL OR b.landlord_id = p_landlord);

  -- Each bill payment, oldest first, never more than the bill — for a bill
  -- whose expense has nothing paid on it yet (the first move).
  INSERT INTO landlord_expense_payments
    (expense_id, landlord_id, paid_on, amount, method, source, memo, created_by, created_at)
  SELECT x.expense_id, x.landlord_id, x.paid_on, x.applied, 'other', 'migrated',
         'Paid on the old GAM Books Bills page', x.created_by, x.created_at
    FROM (SELECT b.migrated_expense_id AS expense_id, b.landlord_id, p.paid_on, p.created_by, p.created_at,
                 LEAST(p.amount, GREATEST(0, b.amount - COALESCE(sum(p.amount) OVER (
                   PARTITION BY p.bill_id ORDER BY p.paid_on, p.created_at, p.id
                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0))) AS applied
            FROM books_bill_payments p JOIN books_bills b ON b.id = p.bill_id
           WHERE b.migrated_expense_id IS NOT NULL AND p.amount > 0
             AND (p_landlord IS NULL OR b.landlord_id = p_landlord)) x
    JOIN landlord_expenses e ON e.id = x.expense_id AND e.status = 'active'
   WHERE x.applied > 0
     AND NOT EXISTS (SELECT 1 FROM landlord_expense_payments q WHERE q.expense_id = x.expense_id);
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

  -- 10/12 review: what the bill says was paid beyond what its expense already
  -- has from it (the old pay route moves amount_paid; a payment row may come
  -- too) — dated the latest payment row when those cover it, else the day the
  -- bill was paid off, else today; never more than the bill, nor than the
  -- expense still owes.
  INSERT INTO landlord_expense_payments
    (expense_id, landlord_id, paid_on, amount, method, source, memo)
  SELECT x.expense_id, x.landlord_id, x.day, x.delta, 'other', 'migrated', 'Paid on the old GAM Books Bills page'
    FROM (SELECT b.migrated_expense_id AS expense_id, b.landlord_id,
                 LEAST(LEAST(b.amount, GREATEST(COALESCE(b.amount_paid, 0), COALESCE(bp.paid, 0))) - COALESCE(mp.paid, 0),
                       e.amount - COALESCE(ap.paid, 0)) AS delta,
                 CASE WHEN bp.last_day IS NOT NULL AND COALESCE(bp.paid, 0) >= COALESCE(b.amount_paid, 0) THEN bp.last_day
                      ELSE COALESCE(b.paid_at::date, CURRENT_DATE) END AS day
            FROM books_bills b
            JOIN landlord_expenses e ON e.id = b.migrated_expense_id AND e.status = 'active'
            LEFT JOIN (SELECT bill_id, sum(amount) AS paid, max(paid_on) AS last_day FROM books_bill_payments GROUP BY bill_id) bp
                   ON bp.bill_id = b.id
            LEFT JOIN (SELECT expense_id, sum(amount) AS paid FROM landlord_expense_payments
                        WHERE voided_at IS NULL AND source = 'migrated' GROUP BY expense_id) mp ON mp.expense_id = e.id
            LEFT JOIN (SELECT expense_id, sum(amount) AS paid FROM landlord_expense_payments
                        WHERE voided_at IS NULL GROUP BY expense_id) ap ON ap.expense_id = e.id
           WHERE b.landlord_id IS NOT NULL AND (p_landlord IS NULL OR b.landlord_id = p_landlord)) x
   WHERE x.delta > 0;
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

  -- ── Transactions: money out → expenses paid that day ──────────────────────
  INSERT INTO landlord_expenses
    (landlord_id, category, category_id, amount, description, expense_date,
     is_common, allocate_per_unit, status, payments_tracked, migrated_from_table, migrated_from_id, created_at, updated_at)
  SELECT t.landlord_id, books_legacy_expense_key(m.cat), m.cat, abs(t.amount),
         concat_ws(' — ', NULLIF(btrim(t.description), ''), NULLIF(btrim(t.reference), '')),
         t.date, FALSE, FALSE, 'active', TRUE, 'books_transactions', t.id, COALESCE(t.created_at, now()), now()
    FROM books_transactions t
   CROSS JOIN LATERAL (SELECT books_category_for_row(t.landlord_id, 'expense', t.category, t.account_id, t.date) AS cat) m
   WHERE t.landlord_id IS NOT NULL AND (p_landlord IS NULL OR t.landlord_id = p_landlord)
     AND t.type = 'expense' AND t.deleted_at IS NULL AND t.migrated_expense_id IS NULL AND t.amount <> 0
     AND NOT EXISTS (SELECT 1 FROM landlord_expenses e
                      WHERE e.migrated_from_table = 'books_transactions' AND e.migrated_from_id = t.id AND e.status = 'active');
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

  UPDATE books_transactions t SET migrated_expense_id = e.id, migrated_at = now()
    FROM landlord_expenses e
   WHERE e.migrated_from_table = 'books_transactions' AND e.migrated_from_id = t.id AND e.status = 'active'
     AND t.migrated_expense_id IS NULL AND (p_landlord IS NULL OR t.landlord_id = p_landlord);

  INSERT INTO landlord_expense_payments
    (expense_id, landlord_id, paid_on, amount, method, source, memo, created_at)
  SELECT e.id, e.landlord_id, e.expense_date, e.amount, 'other', 'migrated',
         'Typed on the old GAM Books Transactions page', e.created_at
    FROM landlord_expenses e
   WHERE e.migrated_from_table = 'books_transactions' AND e.status = 'active'
     AND (p_landlord IS NULL OR e.landlord_id = p_landlord)
     AND NOT EXISTS (SELECT 1 FROM landlord_expense_payments q WHERE q.expense_id = e.id);

  -- ── Transactions: money in → other income ─────────────────────────────────
  INSERT INTO landlord_other_income
    (landlord_id, category, category_id, amount, description, income_date, is_common, status,
     migrated_from_table, migrated_from_id, created_at, updated_at)
  SELECT t.landlord_id,
         COALESCE((SELECT c.system_key FROM books_categories c WHERE c.id = m.cat), 'other'), m.cat,
         abs(t.amount),
         concat_ws(' — ', NULLIF(btrim(t.description), ''), NULLIF(btrim(t.reference), '')),
         t.date, FALSE, 'active', 'books_transactions', t.id, COALESCE(t.created_at, now()), now()
    FROM books_transactions t
   CROSS JOIN LATERAL (SELECT books_category_for_row(t.landlord_id, 'income', t.category, t.account_id, t.date) AS cat) m
   WHERE t.landlord_id IS NOT NULL AND (p_landlord IS NULL OR t.landlord_id = p_landlord)
     AND t.type = 'income' AND t.deleted_at IS NULL AND t.migrated_other_income_id IS NULL AND t.amount <> 0
     AND NOT EXISTS (SELECT 1 FROM landlord_other_income o
                      WHERE o.migrated_from_table = 'books_transactions' AND o.migrated_from_id = t.id AND o.status = 'active');
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

  UPDATE books_transactions t SET migrated_other_income_id = o.id, migrated_at = now()
    FROM landlord_other_income o
   WHERE o.migrated_from_table = 'books_transactions' AND o.migrated_from_id = t.id AND o.status = 'active'
     AND t.migrated_other_income_id IS NULL AND (p_landlord IS NULL OR t.landlord_id = p_landlord);
  RETURN n;
END $$;

COMMENT ON FUNCTION books_move_retired_rows(uuid) IS
  '10/12 (Nic, L5): moves what the old GAM Books Bills and Transactions pages hold for a landlord company onto Expenses / other income (and a bill''s payments onto its expense). Idempotent; run by the migration and by the window triggers.';

-- The window triggers (below) are made after the first move, so the move's
-- own writes never re-run it (and a second run of this file starts clean).
DROP TRIGGER IF EXISTS books_bills_move ON books_bills;
DROP TRIGGER IF EXISTS books_bill_payments_move ON books_bill_payments;
DROP TRIGGER IF EXISTS books_transactions_move ON books_transactions;
DROP TRIGGER IF EXISTS books_transactions_removed_follows ON books_transactions;

SELECT books_move_retired_rows(NULL);

-- ── The window: the old pages keep writing until the code ships ──────────────
-- A moved transaction the old page corrects, removes or switches: what it
-- moved to follows (see the header). In the trigger's statement.
CREATE OR REPLACE FUNCTION books_transaction_moved_follows(t books_transactions, removed boolean) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  cat uuid;
  words text := concat_ws(' — ', NULLIF(btrim(t.description), ''), NULLIF(btrim(t.reference), ''));
BEGIN
  IF t.migrated_expense_id IS NOT NULL THEN
    IF removed OR t.deleted_at IS NOT NULL OR t.type <> 'expense' OR t.amount = 0 THEN
      UPDATE landlord_expenses SET status = 'voided', voided_at = now(), updated_at = now()
       WHERE id = t.migrated_expense_id AND status = 'active';
      IF NOT removed THEN
        UPDATE books_transactions
           SET migrated_expense_id = NULL, migrated_at = CASE WHEN migrated_other_income_id IS NULL THEN NULL ELSE migrated_at END
         WHERE id = t.id;
      END IF;
    ELSE
      cat := books_category_for_row(t.landlord_id, 'expense', t.category, t.account_id, t.date);
      UPDATE landlord_expenses
         SET amount = abs(t.amount), expense_date = t.date, description = words,
             category = books_legacy_expense_key(cat), category_id = cat, updated_at = now()
       WHERE id = t.migrated_expense_id AND status = 'active'
         AND (amount, expense_date, description, category_id) IS DISTINCT FROM (abs(t.amount), t.date, words, cat);
      UPDATE landlord_expense_payments
         SET amount = abs(t.amount), paid_on = t.date, updated_at = now()
       WHERE expense_id = t.migrated_expense_id AND voided_at IS NULL AND source = 'migrated'
         AND (amount, paid_on) IS DISTINCT FROM (abs(t.amount), t.date);
    END IF;
  END IF;
  IF t.migrated_other_income_id IS NOT NULL THEN
    IF removed OR t.deleted_at IS NOT NULL OR t.type <> 'income' OR t.amount = 0 THEN
      UPDATE landlord_other_income SET status = 'voided', voided_at = now(), updated_at = now()
       WHERE id = t.migrated_other_income_id AND status = 'active';
      IF NOT removed THEN
        UPDATE books_transactions
           SET migrated_other_income_id = NULL, migrated_at = CASE WHEN migrated_expense_id IS NULL THEN NULL ELSE migrated_at END
         WHERE id = t.id;
      END IF;
    ELSE
      cat := books_category_for_row(t.landlord_id, 'income', t.category, t.account_id, t.date);
      UPDATE landlord_other_income
         SET amount = abs(t.amount), income_date = t.date, description = words,
             category = COALESCE((SELECT c.system_key FROM books_categories c WHERE c.id = cat), 'other'), category_id = cat,
             updated_at = now()
       WHERE id = t.migrated_other_income_id AND status = 'active'
         AND (amount, income_date, description, category_id) IS DISTINCT FROM (abs(t.amount), t.date, words, cat);
    END IF;
  END IF;
END $$;

-- The triggers. Only for the old pages' own writes: a change to what a row
-- says (never to the move's own pointer columns), at trigger depth 1.
CREATE OR REPLACE FUNCTION books_retired_rows_follow() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NULL END;
  END IF;
  IF TG_TABLE_NAME = 'books_transactions' THEN
    IF TG_OP = 'DELETE' THEN
      PERFORM books_transaction_moved_follows(OLD, TRUE);
      RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' THEN PERFORM books_transaction_moved_follows(NEW, FALSE); END IF;
  END IF;
  PERFORM books_move_retired_rows(NEW.landlord_id);
  RETURN NULL;
END $$;

CREATE TRIGGER books_bills_move AFTER INSERT OR UPDATE OF landlord_id, amount, amount_paid, paid_at, status ON books_bills
  FOR EACH ROW WHEN (NEW.landlord_id IS NOT NULL) EXECUTE FUNCTION books_retired_rows_follow();
CREATE TRIGGER books_bill_payments_move AFTER INSERT ON books_bill_payments
  FOR EACH ROW WHEN (NEW.landlord_id IS NOT NULL) EXECUTE FUNCTION books_retired_rows_follow();
CREATE TRIGGER books_transactions_move
  AFTER INSERT OR UPDATE OF landlord_id, date, description, amount, type, category, account_id, reference, deleted_at ON books_transactions
  FOR EACH ROW WHEN (NEW.landlord_id IS NOT NULL) EXECUTE FUNCTION books_retired_rows_follow();
CREATE TRIGGER books_transactions_removed_follows BEFORE DELETE ON books_transactions
  FOR EACH ROW WHEN (OLD.landlord_id IS NOT NULL) EXECUTE FUNCTION books_retired_rows_follow();

COMMENT ON FUNCTION books_retired_rows_follow() IS
  '10/12 (Nic, L5): until the code that retires the old Bills and Transactions pages ships, every landlord row they write is moved (and kept in step) at once.';
