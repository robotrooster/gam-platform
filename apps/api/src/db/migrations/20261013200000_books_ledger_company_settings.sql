-- 10/12 (Nic) — GAM BOOKS LEDGER: EACH COMPANY'S BOOKS SETTINGS
--
-- GAM Books is becoming an automatic double-entry ledger (gam-ledger-design-
-- 2026-10-12 §3-§9, §13; phase P3 "ledger engine, dark"). Four choices belong
-- to the company, and Nic answered on 10/12 that each is the LANDLORD'S CHOICE:
--
--   books_timezone          the calendar company-level lines are dated on
--                           (payroll, company-wide bills, owner equity). NULL
--                           until the company's chart is first set up; the
--                           engine then pins it to the first property's
--                           timezone (America/Phoenix when there is none), so
--                           a later property sale never moves old dates.
--   books_close_by          who may close a month (L3: "owner decides who can
--                           close and reopen"; closing is optional):
--                           'owner' or 'owner_or_bookkeeper' (a bookkeeper with
--                           Books write access and the company-wide box).
--   books_reopen_by         who may reopen a closed month, the same two choices.
--   books_open_month_fixes  where a fix to a month that is still OPEN shows (L4):
--                           'restate' (change that month, QuickBooks' way) or
--                           'day_made' (leave the month alone; the fix shows on
--                           the day it was made). A CLOSED month is never
--                           changed either way — its fixes land in the first
--                           open month, labeled as corrections (§13).
--
-- Defaults are the design's recommendation: a company-wide bookkeeper may
-- close, only the owner reopens, open-month fixes restate. Values match
-- LEDGER_CLOSE_PERMISSIONS and LEDGER_OPEN_MONTH_FIX_MODES in
-- packages/shared/src/booksLedger.ts.
--
-- The ledger is DARK: nothing reads these until the close screen and reports
-- ship. Expand-only, safe to apply before the code ships.
-- No backfill needed: the defaults are the starting choices; books_timezone is
-- filled by the engine the first time a company's chart is set up.
-- Safe drop: the four columns and their CHECKs.

SET LOCAL lock_timeout = '10s';

ALTER TABLE landlords
  ADD COLUMN IF NOT EXISTS books_timezone         text,
  ADD COLUMN IF NOT EXISTS books_close_by         text NOT NULL DEFAULT 'owner_or_bookkeeper',
  ADD COLUMN IF NOT EXISTS books_reopen_by        text NOT NULL DEFAULT 'owner',
  ADD COLUMN IF NOT EXISTS books_open_month_fixes text NOT NULL DEFAULT 'restate';

ALTER TABLE landlords
  ADD CONSTRAINT landlords_books_close_by_check
    CHECK (books_close_by IN ('owner', 'owner_or_bookkeeper')),
  ADD CONSTRAINT landlords_books_reopen_by_check
    CHECK (books_reopen_by IN ('owner', 'owner_or_bookkeeper')),
  ADD CONSTRAINT landlords_books_open_month_fixes_check
    CHECK (books_open_month_fixes IN ('restate', 'day_made'));

COMMENT ON COLUMN landlords.books_timezone IS
  '10/12 (Nic, ledger): the calendar company-level ledger lines are dated on. Pinned by the engine to the first property''s timezone when the chart is first set up.';
COMMENT ON COLUMN landlords.books_close_by IS
  '10/12 (Nic, L3): who may close a month — owner, or owner_or_bookkeeper (Books write access + company-wide box). LEDGER_CLOSE_PERMISSIONS.';
COMMENT ON COLUMN landlords.books_reopen_by IS
  '10/12 (Nic, L3): who may reopen a closed month. LEDGER_CLOSE_PERMISSIONS.';
COMMENT ON COLUMN landlords.books_open_month_fixes IS
  '10/12 (Nic, L4): a fix to an open month — restate (change that month) or day_made (show it on the day made). LEDGER_OPEN_MONTH_FIX_MODES.';
