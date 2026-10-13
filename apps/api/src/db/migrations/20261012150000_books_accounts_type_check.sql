-- 10/11 (Nic) — GAM BOOKS: AN ACCOUNT'S TYPE IS ONE OF FIVE
--
-- POST /books/accounts stored whatever `type` it was sent, and the table had
-- no CHECK. Every report reads the chart by type — the P&L reads income and
-- expense, the balance sheet asset, liability and equity — so an account typed
-- 'Income', 'revenue' or anything else silently fell out of every report.
-- routes/books.ts now validates against BOOKS_ACCOUNT_TYPES
-- (packages/shared/src/booksLedger.ts); this CHECK lists the same five values,
-- so the database refuses what the route would.
--
-- Existing rows: a type that differs from one of the five only by case or
-- spacing ('Income ') is normalized first. Production had 0 accounts on 10/12
-- (read-only count), so nothing is expected to remain outside the five. If
-- anything does, the CHECK is still added — NOT VALID, so every new or changed
-- row is held to it — and left unvalidated with a NOTICE naming the count,
-- rather than failing the migration over a row nobody can see in a report.
--
-- Backfill: only the normalization above.
-- Safe drop: the constraint; nothing else depends on it.

UPDATE books_accounts
   SET type = lower(btrim(type)), updated_at = now()
 WHERE type <> lower(btrim(type))
   AND lower(btrim(type)) IN ('asset', 'liability', 'equity', 'income', 'expense');

ALTER TABLE books_accounts
  ADD CONSTRAINT books_accounts_type_check
  CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')) NOT VALID;

DO $$
DECLARE
  outside integer;
BEGIN
  SELECT count(*) INTO outside
    FROM books_accounts
   WHERE type NOT IN ('asset', 'liability', 'equity', 'income', 'expense');
  IF outside = 0 THEN
    ALTER TABLE books_accounts VALIDATE CONSTRAINT books_accounts_type_check;
  ELSE
    RAISE NOTICE 'books_accounts_type_check left NOT VALID: % account(s) have a type outside the five', outside;
  END IF;
END $$;
