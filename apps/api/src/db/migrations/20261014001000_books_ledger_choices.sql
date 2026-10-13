-- 10/12 (Nic) — GAM BOOKS: THE COMPANY'S OWN CHOICES FOR HOW ITS BOOKS COUNT MONEY
--
-- GAM Books is becoming an automatic double-entry ledger (gam-ledger-design-
-- 2026-10-12). Nic answered on 10/12 that each of these is the LANDLORD'S
-- CHOICE, made on the Books settings page (routes/booksSettings.ts):
--
--   books_history_start          where the books begin (books_start_date, the
--                                bank feed's cutoff too, keeps the date):
--                                'since_joining' — the first day of the month
--                                the company joined GAM; 'start_date' — a date
--                                the owner picks, with what came before entered
--                                once as opening balances.
--   books_home_sale_method       L11 home sales: 'whole_sale_at_signing' (the
--                                sale when signed, a note owed for the rest) or
--                                'income_as_paid' (income as each payment comes in).
--   books_work_trade_method      L12 work-trade hours covering rent:
--                                'rent_and_labor' (full rent + a labor cost) or
--                                'rent_discount'.
--   books_company_costs_method   L7 costs that are no one property's (payroll,
--                                company-wide bills): 'company_bucket' or
--                                'split_by_units'.
--   books_write_off_by           L15 who may write off a balance a tenant will
--                                never pay (kept on record as written off, never
--                                erased): 'owner' or 'owner_or_property_manager'.
--
-- (Who may close and reopen a month, and where a fix to an open month shows,
-- are books_close_by / books_reopen_by / books_open_month_fixes, 20261013200000;
-- register stock, L8, is the register lane's books_register_stock and
-- books_register_stock_from, 20261014150000. The same Books settings page sets
-- them all.)
--
-- NULL = NOT CHOSEN YET, on purpose: GAM picks none of the accounting methods
-- for a company, the way it never picks a books start date (L16, "TruBlu picks
-- its own start date — no default set by GAM"). A record whose posting depends
-- on a method that is not chosen waits until the owner chooses. Who may write
-- off starts at the narrowest answer, the owner only.
--
-- books_history_start has no CHECK tying it to books_start_date: the Bank page
-- may still clear the date (PUT /bank-feed/books-start-date null), and that
-- must keep working; a NULL date simply reads as "not chosen".
--
-- Values match BOOKS_HISTORY_STARTS, BOOKS_HOME_SALE_METHODS,
-- BOOKS_WORK_TRADE_METHODS, BOOKS_COMPANY_COST_METHODS and
-- LEDGER_WRITE_OFF_PERMISSIONS in
-- packages/shared/src/booksLedger.ts (routes/booksSettings.test.ts holds the
-- two together). Every change is journaled by audit_landlords (the change
-- journal, never pruned).
--
-- The ledger is DARK: nothing posts from these until the projector phases ship.
-- Expand-only: nullable columns and one with a constant default (no rewrite);
-- the old code never reads them. Safe to apply before the code ships.
-- No backfill needed: NULL is "not chosen", and a company that already picked a
-- start date on the Bank page reads as 'start_date' (routes/booksSettings).
-- Safe drop: the five columns and their CHECKs.

SET LOCAL lock_timeout = '10s';

ALTER TABLE landlords
  ADD COLUMN IF NOT EXISTS books_history_start         text,
  ADD COLUMN IF NOT EXISTS books_home_sale_method      text,
  ADD COLUMN IF NOT EXISTS books_work_trade_method     text,
  ADD COLUMN IF NOT EXISTS books_company_costs_method  text,
  ADD COLUMN IF NOT EXISTS books_write_off_by          text NOT NULL DEFAULT 'owner';

ALTER TABLE landlords DROP CONSTRAINT IF EXISTS landlords_books_history_start_check;
ALTER TABLE landlords DROP CONSTRAINT IF EXISTS landlords_books_home_sale_method_check;
ALTER TABLE landlords DROP CONSTRAINT IF EXISTS landlords_books_work_trade_method_check;
ALTER TABLE landlords DROP CONSTRAINT IF EXISTS landlords_books_company_costs_method_check;
ALTER TABLE landlords DROP CONSTRAINT IF EXISTS landlords_books_write_off_by_check;

ALTER TABLE landlords
  ADD CONSTRAINT landlords_books_history_start_check
    CHECK (books_history_start IS NULL OR books_history_start IN ('since_joining', 'start_date')),
  ADD CONSTRAINT landlords_books_home_sale_method_check
    CHECK (books_home_sale_method IS NULL OR books_home_sale_method IN ('whole_sale_at_signing', 'income_as_paid')),
  ADD CONSTRAINT landlords_books_work_trade_method_check
    CHECK (books_work_trade_method IS NULL OR books_work_trade_method IN ('rent_and_labor', 'rent_discount')),
  ADD CONSTRAINT landlords_books_company_costs_method_check
    CHECK (books_company_costs_method IS NULL OR books_company_costs_method IN ('company_bucket', 'split_by_units')),
  ADD CONSTRAINT landlords_books_write_off_by_check
    CHECK (books_write_off_by IN ('owner', 'owner_or_property_manager'));

COMMENT ON COLUMN landlords.books_history_start IS
  '10/12 (Nic): how books_start_date was picked — since_joining (first day of the month the company joined GAM) or start_date (the owner''s date + opening balances). NULL = not chosen. BOOKS_HISTORY_STARTS.';
COMMENT ON COLUMN landlords.books_home_sale_method IS
  '10/12 (Nic, L11): home sales count as the whole sale at signing or as income when paid. NULL = not chosen. BOOKS_HOME_SALE_METHODS.';
COMMENT ON COLUMN landlords.books_work_trade_method IS
  '10/12 (Nic, L12): work-trade hours covering rent count as full rent + a labor cost, or a rent discount. NULL = not chosen. BOOKS_WORK_TRADE_METHODS.';
COMMENT ON COLUMN landlords.books_company_costs_method IS
  '10/12 (Nic, L7): company-level costs stay in a Company bucket or are split across properties by units. NULL = not chosen. BOOKS_COMPANY_COST_METHODS.';
COMMENT ON COLUMN landlords.books_write_off_by IS
  '10/12 (Nic, L15): who may write off a balance a tenant will never pay — owner, or owner_or_property_manager. Never a bookkeeper. LEDGER_WRITE_OFF_PERMISSIONS.';
