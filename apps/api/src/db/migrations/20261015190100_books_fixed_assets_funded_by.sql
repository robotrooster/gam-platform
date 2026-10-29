-- 10/13 (Nic) — A FIXED ASSET TYPED IN BY HAND SAYS WHERE ITS MONEY CAME FROM, AND POSTS TO THAT
--
-- Nic, 10/13: "Fixed asset typed by hand: the form ASKS where the money came
-- from (cash on hand / owner put money in / loan / already an expense) and
-- posts to that"; "hand-typed asset 'already an expense' → LINK that expense
-- (cost moves to the asset)".
--
-- Until now an asset bought on or after the books start posted no cost of its
-- own (its cost was assumed to be on the books already), so an asset paid for
-- in cash or by the owner never reached the balance sheet. Now:
--
--   books_fixed_assets.funded_by   where the money came from (BOOKS_FIXED_ASSET_
--                                  FUNDED_BY in packages/shared booksVendorsLoans):
--     cash      cash on hand — the asset posts its cost on the day it was bought:
--               Dr its account (Rental property or Equipment, by class) /
--               Cr Undeposited funds (1040, the office drawer — where an expense
--               paid "Cash from the office" comes out of too)
--     owner     the owner put money in — Dr its account / Cr Owner equity and
--               contributions (3010)
--     loan      a loan on the Loans page (funded_loan_id) whose money went
--               straight to the seller: the loan's own posting already put the
--               cost on Rental property or Equipment (Dr) against the loan
--               (Cr), so the asset posts no cost of its own — never twice
--     expense   already an expense (source_expense_id): the expense's cost
--               moves from the expense's account to the asset's account (the
--               expense posts it there — services/ledgerProjectors/moneyOut),
--               counted once. An expense filed under a capital-improvement
--               category is on an asset account already and stays there.
--   books_fixed_assets.funded_loan_id   the loan, for 'loan'.
--
-- An asset bought before the books start opens on the books start date as it
-- did (cost against Opening balance equity): nothing is asked. NULL funded_by
-- on an asset bought on or after the start (entered before 10/13) still posts
-- no cost of its own — the page asks for it.
--
-- The guards: a loan an asset stands on cannot be voided, or have where its
-- money went changed, while the asset stands (the asset's cost would leave the
-- books while its depreciation went on) — the same rule as the expense an
-- asset was made from (landlord_expenses_asset_guard).
-- 10/13 review: and the loan and the asset stay on the same side of the books
-- start. A loan made before it opens at what was still owed that day against
-- Opening balance equity, so it never put the cost of an asset bought on or
-- after the start on the books (the asset would depreciate a cost the books
-- never had); a loan made on or after it posts the cost that day while an
-- asset bought before the start opens with its own cost (twice). The Fixed
-- assets page refuses that pairing (routes/booksLoansAssets assetFunding);
-- here the loan's day cannot move across the start (books_loans_asset_guard),
-- nor the books start move between the two (books_start_asset_loan_guard, on
-- landlords — it fires only when books_start_date itself changes).
--
-- The capture: the two columns are appended to the asset's capture list
-- (LEDGER_CAPTURE_COLUMNS in packages/shared, same order), and an asset's
-- change now also marks the expense it names and that expense's payments —
-- linking an expense (or voiding the asset, or changing its class) moves where
-- the expense posts its cost, and what each payment toward it paid for.
--
-- Expand-only: two nullable columns, two checks every existing row meets, two
-- guard triggers, the capture re-installed (replaces its three trigger bodies
-- only — ledger_install_capture, 20261013200600). No backfill needed:
-- production has no fixed asset. Idempotent.
-- Safe drop: the guard triggers and functions, the checks, the columns (after
-- re-installing the capture as 20261014190300 left it).

SET LOCAL lock_timeout = '10s';

ALTER TABLE books_fixed_assets ADD COLUMN IF NOT EXISTS funded_by text;
-- No foreign key: a loan is never removed (books_loans_guard refuses a DELETE),
-- the route checks the loan is the company's, and the guard below keeps it as
-- it is while the asset stands; a key would only make clearing the two tables
-- order-dependent.
ALTER TABLE books_fixed_assets ADD COLUMN IF NOT EXISTS funded_loan_id uuid;

ALTER TABLE books_fixed_assets DROP CONSTRAINT IF EXISTS books_fixed_assets_funded_by_check;
ALTER TABLE books_fixed_assets ADD CONSTRAINT books_fixed_assets_funded_by_check
  CHECK (funded_by IS NULL OR funded_by IN ('cash', 'owner', 'loan', 'expense'));

-- A loan names its loan; an expense names its expense; nothing else names either.
ALTER TABLE books_fixed_assets DROP CONSTRAINT IF EXISTS books_fixed_assets_funded_shape;
ALTER TABLE books_fixed_assets ADD CONSTRAINT books_fixed_assets_funded_shape
  CHECK ((funded_loan_id IS NOT NULL) = (funded_by IS NOT DISTINCT FROM 'loan')
         AND (funded_by IS DISTINCT FROM 'expense' OR source_expense_id IS NOT NULL)
         AND (source_expense_id IS NULL OR funded_by IS NULL OR funded_by = 'expense'));

CREATE INDEX IF NOT EXISTS books_fixed_assets_loan ON books_fixed_assets (funded_loan_id) WHERE funded_loan_id IS NOT NULL;

COMMENT ON COLUMN books_fixed_assets.funded_by IS
  '10/13 (Nic): where the money for an asset typed in by hand came from — cash (cash on hand: Cr Undeposited funds 1040), owner (Cr Owner equity and contributions 3010), loan (funded_loan_id; the loan''s own posting carries the cost), expense (source_expense_id; the expense''s cost moves to the asset''s account). NULL: not asked (bought before the books start), or entered before 10/13. BOOKS_FIXED_ASSET_FUNDED_BY.';
COMMENT ON COLUMN books_fixed_assets.funded_loan_id IS
  '10/13 (Nic): for funded_by = loan, the loan (Loans page) whose money went straight to the seller of this asset.';

-- A loan an asset stands on stays as it is while the asset stands, and its
-- day stays on the asset's side of the books start.
CREATE OR REPLACE FUNCTION books_loans_asset_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  a record;
BEGIN
  IF (NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL) OR NEW.funded_to IS DISTINCT FROM OLD.funded_to THEN
    SELECT f.name INTO a FROM books_fixed_assets f WHERE f.funded_loan_id = NEW.id AND f.voided_at IS NULL LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'This loan paid for the fixed asset "%". Void the asset on the Fixed assets page first.', a.name
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.start_date IS DISTINCT FROM OLD.start_date THEN
    SELECT f.name, f.acquired_on, x.books_start_date INTO a
      FROM books_fixed_assets f JOIN landlords x ON x.id = f.landlord_id
     WHERE f.funded_loan_id = NEW.id AND f.voided_at IS NULL AND x.books_start_date IS NOT NULL
       AND (NEW.start_date < x.books_start_date) <> (f.acquired_on < x.books_start_date)
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'This loan paid for the fixed asset "%", bought on %. Your books start on %, and the loan''s day cannot be on the other side of that day from the asset''s (the asset''s cost would count twice, or not at all). Change the asset''s day on the Fixed assets page first.',
        a.name, a.acquired_on, a.books_start_date
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS books_loans_asset_guard ON books_loans;
CREATE TRIGGER books_loans_asset_guard BEFORE UPDATE OF voided_at, funded_to, start_date ON books_loans
  FOR EACH ROW EXECUTE FUNCTION books_loans_asset_guard();

-- The books start does not move between an asset and the loan that paid for it.
CREATE OR REPLACE FUNCTION books_start_asset_loan_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  a record;
BEGIN
  SELECT f.name AS asset_name, f.acquired_on, l.name AS loan_name, l.start_date INTO a
    FROM books_fixed_assets f JOIN books_loans l ON l.id = f.funded_loan_id
   WHERE f.landlord_id = NEW.id AND f.voided_at IS NULL AND f.funded_by = 'loan'
     AND (l.start_date < NEW.books_start_date) <> (f.acquired_on < NEW.books_start_date)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Your books cannot start on %: the fixed asset "%" (bought on %) and the loan "%" that paid for it (made on %) would be on different sides of that day, so the asset''s cost would count twice, or not at all. Change the asset''s day or the loan''s first.',
      NEW.books_start_date, a.asset_name, a.acquired_on, a.loan_name, a.start_date
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS books_start_asset_loan_guard ON landlords;
CREATE TRIGGER books_start_asset_loan_guard BEFORE UPDATE OF books_start_date ON landlords
  FOR EACH ROW WHEN (NEW.books_start_date IS NOT NULL AND NEW.books_start_date IS DISTINCT FROM OLD.books_start_date)
  EXECUTE FUNCTION books_start_asset_loan_guard();

-- ── The ledger capture (LEDGER_CAPTURE_COLUMNS in packages/shared) ──────────
-- As 20261014190300 installed it (the asset's opening and every month of its
-- life that has ended), plus the expense it names and that expense's payments.
SELECT ledger_install_capture('books_fixed_assets',
  ARRAY['landlord_id', 'business_id', 'property_id', 'name', 'asset_class', 'cost', 'salvage_value',
        'acquired_on', 'in_service_date', 'life_years', 'method', 'prior_depreciation', 'source_expense_id', 'voided_at',
        'funded_by', 'funded_loan_id'],
  $k$SELECT 'fixed_asset'::text, r.id::text, COALESCE(r.landlord_id, r.business_id)
      UNION ALL
      SELECT 'fixed_asset', r.id::text || '|' || to_char(m, 'YYYY-MM'), COALESCE(r.landlord_id, r.business_id)
        FROM generate_series(
               date_trunc('month', GREATEST(r.in_service_date,
                 COALESCE((SELECT l.books_start_date FROM landlords l WHERE l.id = r.landlord_id), r.in_service_date))),
               date_trunc('month', r.in_service_date)
                 + make_interval(months => COALESCE(round(r.life_years * 12)::int, 0) - 1),
               interval '1 month') AS m
       WHERE r.life_years IS NOT NULL
         AND (m + interval '1 month')::date <= CURRENT_DATE
      UNION ALL
      SELECT 'expense', r.source_expense_id::text, r.landlord_id
      UNION ALL
      SELECT 'expense_payment', xp.id::text, xp.landlord_id
        FROM landlord_expense_payments xp WHERE xp.expense_id = r.source_expense_id$k$);

-- Everything installed still matches its table.
SELECT ledger_check_capture();
