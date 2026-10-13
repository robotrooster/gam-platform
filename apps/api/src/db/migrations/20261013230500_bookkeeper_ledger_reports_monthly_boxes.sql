-- 10/12 (Nic) — THREE MORE BOXES ON A BOOKKEEPER, EACH THE OWNER'S CHOICE
--
-- Nic's answers on 10/12 (gam-nic-answers-2026-10-12 BK1, BK2, BK-monthly-report):
--
--   BK1  "property-only bookkeeper + Books ledger: LANDLORD'S CHOICE per
--        bookkeeper (a box: may use the whole-company ledger)". Until today a
--        bookkeeper without the company-wide box could not open the GAM Books
--        ledger at all (chart of accounts, journal, transactions, bank
--        reconciliation, bills, vendors, payroll, tax, P&L, balance sheet),
--        because none of it is split by property. The owner may now give the
--        ledger to a property bookkeeper on its own. The bank account and
--        payouts (and the Books cash flow and owner statements, which carry
--        the payouts) stay the company-wide box's.
--   BK2  "company reports for partial bookkeeper: LANDLORD'S CHOICE per
--        bookkeeper (only their properties vs whole company)". The Books
--        company reports (P&L, cash flow, owner statements) carry only the
--        ticked properties' money unless this box is ticked; ticked, they
--        carry the whole company's (everything the company still owns; a sold
--        property they never kept stays hidden — BK3).
--   BK-monthly-report  "bookkeepers see the monthly report on screen =
--        LANDLORD'S CHOICE per bookkeeper". The Reports page's Monthly report
--        tab, for their properties only.
--
--   company_ledger          BK1 (default off)
--   whole_company_reports   BK2 (default off)
--   sees_monthly_report     BK-monthly-report (default off)
--
-- EXPAND ONLY, safe to apply before the code ships: three new columns with a
-- FALSE default; nothing reads them until the code that knows them is live,
-- and FALSE is what every bookkeeper has today. No backfill needed: nobody
-- held any of the three before today (a company-wide bookkeeper already
-- reaches the ledger through the company-wide box, and keeps doing so). The
-- INSERT-aware audit trigger on bookkeeper_scopes (20261012160100) journals
-- every grant and change of these boxes with the rest of the row.
--
-- Safe drop: the three columns (after the code that reads them is gone).

ALTER TABLE bookkeeper_scopes
  ADD COLUMN IF NOT EXISTS company_ledger boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whole_company_reports boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sees_monthly_report boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN bookkeeper_scopes.company_ledger IS
  '10/12 (Nic, BK1): the owner''s choice to let this bookkeeper use the whole-company GAM Books ledger (chart, journal, transactions, bank reconciliation, bills, vendors, payroll, tax, P&L, balance sheet) without the company-wide box. Never the bank account or payouts.';
COMMENT ON COLUMN bookkeeper_scopes.whole_company_reports IS
  '10/12 (Nic, BK2): the owner''s choice that this bookkeeper''s Books company reports (P&L, cash flow, owner statements) carry the whole company''s money, not only the ticked properties''. A sold property they never kept stays hidden.';
COMMENT ON COLUMN bookkeeper_scopes.sees_monthly_report IS
  '10/12 (Nic): the owner''s choice to show this bookkeeper the monthly property report on screen (their properties only).';
