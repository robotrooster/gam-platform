-- 10/13 (Nic) — COMPANY-LEVEL COSTS GO TO THE COMPANY COLUMN UNTIL THE OWNER PICKS; A LATER SPLIT SPLITS ONLY NEW COSTS
--
-- Nic, 10/13: "Company-level costs before the owner picks: post to the
-- COMPANY column by default", for "EVERY company-level cost" (GAM's charges,
-- payroll, loan interest, company-wide bills, depreciation — everything that
-- waited on landlords.books_company_costs_method, services/ledgerProjectors/
-- companyCosts); and "a later 'split by units' splits only NEW costs" — what
-- is already in the Company column stays there.
--
-- So a NULL method no longer holds a cost back: it reads as the Company
-- column. When the owner then picks a method AFTER the books have posted, the
-- pick applies only to costs recorded from that moment on, and this column is
-- that moment (services/booksSettings sets it; NULL = the method applies to
-- every cost — picked before anything posted, or never picked). A cost is
-- "recorded" when its record was made (an expense, a loan payment, a GAM
-- charge), a payroll run approved, an instant payout's fee collected, a card
-- reader piece collected, a month of depreciation over (and its asset
-- entered). The projectors read these stored times, so a rebuild comes out
-- the same tomorrow.
--
-- The method itself stays fixed once chosen and the books have posted
-- (services/booksSettings), so one moment is all a company ever has.
--
-- Expand-only: one nullable column. No backfill needed: no company on
-- production has picked a method (books_company_costs_method is NULL on every
-- row), so nothing posted under an earlier pick. Idempotent.
-- Safe drop: the column (the projectors then read every pick as applying to
-- every cost, as before 10/13).

SET LOCAL lock_timeout = '10s';

ALTER TABLE landlords ADD COLUMN IF NOT EXISTS books_company_costs_from timestamptz;

COMMENT ON COLUMN landlords.books_company_costs_from IS
  '10/13 (Nic): the moment books_company_costs_method was picked, when the books had already posted — the method applies to company-level costs recorded from then on; costs recorded before stay in the Company column (the default while not chosen). NULL = the method applies to every cost.';
