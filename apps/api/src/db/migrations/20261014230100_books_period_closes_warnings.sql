-- 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P9: A CLOSE KEEPS WHAT IT WAS WARNED ABOUT
--
-- Closing a month (Books → Close month, gam-ledger-design-2026-10-12 §13) is
-- refused while anything blocks it (money still waiting to post, a books check
-- that does not tie out, a linked bank account not reconciled through the
-- month's end). Some things only WARN and never block: bank lines nobody has
-- filed yet, money sitting in "Suspense: to classify", bills past their due
-- date and unpaid, a bank account with no linked feed that was not reconciled.
--
-- The person who closes sees those warnings and closes anyway. The close's own
-- record (books_period_closes, never changed) now keeps what they were shown,
-- so the history answers "what did we know when September was closed?":
--
--   warnings  jsonb array of { kind, count, amount, text } — kind is one of
--             LEDGER_CLOSE_WARNINGS (packages/shared/src/booksLedger.ts);
--             '[]' when nothing warned, and for a reopen.
--
-- books_period_closes is append-only (a trigger refuses UPDATE and DELETE);
-- adding a column with a constant default rewrites nothing and fires no row
-- trigger. Expand-only, safe before the code ships (the old code never names
-- the column; its rows get '[]').
-- No backfill needed (production has no closes).
-- Safe drop: the column and its CHECK.

SET LOCAL lock_timeout = '10s';

ALTER TABLE books_period_closes
  ADD COLUMN IF NOT EXISTS warnings jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE books_period_closes DROP CONSTRAINT IF EXISTS books_period_closes_warnings_is_list;
ALTER TABLE books_period_closes
  ADD CONSTRAINT books_period_closes_warnings_is_list CHECK (jsonb_typeof(warnings) = 'array');

COMMENT ON COLUMN books_period_closes.warnings IS
  '10/12 (Nic, ledger P9): what the person closing the month was warned about and closed anyway — [{kind, count, amount, text}], kind in LEDGER_CLOSE_WARNINGS.';
