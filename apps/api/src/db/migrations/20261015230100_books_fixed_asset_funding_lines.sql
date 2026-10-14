-- 10/13 (Nic) — A FIXED ASSET'S MONEY MAY COME FROM SEVERAL PLACES; ONE LOAN MAY PAY FOR SEVERAL ASSETS
--
-- Nic, 10/13: "Funding: ALLOW A MIX (several funding lines adding up to the
-- cost; a loan may spread over several assets)" — e.g. an $8,000 mower bought
-- with $6,000 from a loan and $2,000 cash on hand. And on cash on hand: "they
-- don't pick as a setting, they pick as the expense happens" — the form lists
-- where money can come from on each asset; nothing is remembered.
--
-- books_fixed_asset_funding: one row per line, each one of
-- BOOKS_FIXED_ASSET_FUNDED_BY (packages/shared booksVendorsLoans) with its
-- amount. What an asset bought on or after the books start posts for its
-- cost, on the day it was bought (services/ledgerProjectors/loansAssets):
--
--   cash     Dr its account / Cr Undeposited funds (1040, the office drawer)
--   owner    Dr its account / Cr Owner equity and contributions (3010)
--   loan     nothing here: the loan's own posting (its money straight to the
--            seller) put that much on Rental property or Equipment
--   expense  nothing here: the expense (its whole amount) posts its cost to
--            the asset's account instead of its category's (moneyOut)
--
-- The rules, held here at commit so no screen or job can leave them broken:
--   - a live asset with live lines has no single funded_by / funded_loan_id /
--     source_expense_id (the 10/13 single answer, still accepted as one line
--     for the whole cost — 20261015190100);
--   - its live lines add up to its cost, and are its company's;
--   - the live lines naming one loan, across every live asset (and an asset
--     that named it alone, for its whole cost), never add up to more than was
--     borrowed (books_loan_funding_problem — checked again when a loan's
--     amount changes);
--   - an expense is one asset's (here or by source_expense_id), and a line
--     naming it carries its whole amount, and it is filed where the asset
--     goes (10/13 review: its property, or no property for an asset split
--     across the properties — the expense posts that part of the cost to the
--     asset's account on its own property, so the two must be one place);
--   - a loan or expense a live line names is not voided (and a loan's money
--     does not change where it went) while the asset stands, and an expense's
--     amount, unit and property do not change under it, nor is it deleted
--     (10/13 review: landlord_expenses had no DELETE guard); neither the books start nor a loan's
--     day moves so an asset with a loan or expense line, or the loan, falls
--     before the books start (the asset would open at its full cost too).
--
-- A line is never removed or changed: an edit of an asset's funding stamps
-- its lines replaced_at and adds new ones (keep everything); a voided asset's
-- lines stay as they were (the asset's void says they no longer count).
-- No foreign keys, as funded_loan_id (20261015190100): an asset and a loan are
-- never removed (their guards refuse a DELETE), nor is an expense a live
-- asset stands on (landlord_expenses_asset_delete_guard, below), the routes
-- check each id is the company's, and the rules above check the rest — a key
-- would only make clearing the tables order-dependent.
--
-- books_expense_fixed_asset(expense): the live asset an expense is part of
-- (made from it, or a live line naming it) — what moneyOut, the Expenses
-- record and the guards read.
--
-- The capture: the new table marks its asset's purchase posting, and the
-- expense a line names and that expense's payments (where the expense posts
-- its cost moves); books_fixed_assets is re-installed with cost_place and
-- unit_id (20261015230000) and marks the expenses its lines name too.
--
-- Expand-only: a new table, functions, triggers, the captures re-installed.
-- No backfill needed: production has no fixed asset (counted read-only
-- 10/13). Idempotent.
-- Safe drop: the triggers, the functions, the table (after re-installing the
-- books_fixed_assets capture as 20261015190100 left it, the three guard
-- functions as 20261014190300 / 20261015190100 left them, and the
-- landlord_expenses_asset_guard trigger on status, voided_at and amount only).
-- landlord_expenses_asset_delete_guard and its function drop on their own.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS books_fixed_asset_funding (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     uuid NOT NULL,
  landlord_id  uuid NOT NULL,
  kind         text NOT NULL,
  loan_id      uuid,
  expense_id   uuid,
  amount       numeric(12,2) NOT NULL,
  line_no      smallint NOT NULL DEFAULT 1,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  replaced_at  timestamptz,
  CONSTRAINT books_fixed_asset_funding_kind_check CHECK (kind IN ('cash', 'owner', 'loan', 'expense')),
  CONSTRAINT books_fixed_asset_funding_amount_check CHECK (amount > 0),
  CONSTRAINT books_fixed_asset_funding_shape CHECK ((loan_id IS NOT NULL) = (kind = 'loan') AND (expense_id IS NOT NULL) = (kind = 'expense'))
);

CREATE INDEX IF NOT EXISTS books_fixed_asset_funding_asset ON books_fixed_asset_funding (asset_id);
CREATE INDEX IF NOT EXISTS books_fixed_asset_funding_loan ON books_fixed_asset_funding (loan_id) WHERE loan_id IS NOT NULL AND replaced_at IS NULL;
CREATE INDEX IF NOT EXISTS books_fixed_asset_funding_expense ON books_fixed_asset_funding (expense_id) WHERE expense_id IS NOT NULL AND replaced_at IS NULL;

COMMENT ON TABLE books_fixed_asset_funding IS
  '10/13 (Nic): "Funding: ALLOW A MIX (several funding lines adding up to the cost; a loan may spread over several assets)." Where the money for a fixed asset came from, one line per source (cash on hand, the owner, a loan, an expense already on the books), adding up to its cost. Never removed or changed: an edit stamps replaced_at and adds new lines.';
COMMENT ON COLUMN books_fixed_asset_funding.kind IS
  '10/13 (Nic): BOOKS_FIXED_ASSET_FUNDED_BY — cash (Cr Undeposited funds 1040), owner (Cr Owner equity and contributions 3010), loan (loan_id; the loan''s posting carries it), expense (expense_id, its whole amount; the expense posts it to the asset''s account).';
COMMENT ON COLUMN books_fixed_asset_funding.line_no IS
  '10/13 (Nic): the line''s place in the list as it was said (lines said together share one created_at).';
COMMENT ON COLUMN books_fixed_asset_funding.replaced_at IS
  '10/13 (Nic): when an edit of the asset''s funding replaced this line (NULL: live while its asset is).';

-- A line is a record: never removed; only its replacement is stamped, once.
CREATE OR REPLACE FUNCTION books_fixed_asset_funding_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A fixed asset''s funding line is never removed; say where the money came from again instead.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.replaced_at IS NOT NULL
     OR (NEW.asset_id, NEW.landlord_id, NEW.kind, NEW.loan_id, NEW.expense_id, NEW.amount, NEW.line_no, NEW.created_by, NEW.created_at)
        IS DISTINCT FROM (OLD.asset_id, OLD.landlord_id, OLD.kind, OLD.loan_id, OLD.expense_id, OLD.amount, OLD.line_no, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'A fixed asset''s funding line does not change; say where the money came from again instead.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS books_fixed_asset_funding_guard ON books_fixed_asset_funding;
CREATE TRIGGER books_fixed_asset_funding_guard BEFORE UPDATE OR DELETE ON books_fixed_asset_funding
  FOR EACH ROW EXECUTE FUNCTION books_fixed_asset_funding_guard();

DROP TRIGGER IF EXISTS audit_books_fixed_asset_funding ON books_fixed_asset_funding;
CREATE TRIGGER audit_books_fixed_asset_funding AFTER DELETE OR UPDATE ON books_fixed_asset_funding
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- The live asset an expense is part of: made from it, or a live line naming it.
CREATE OR REPLACE FUNCTION books_expense_fixed_asset(p_expense uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT f.id FROM books_fixed_assets f
   WHERE f.voided_at IS NULL
     AND (f.source_expense_id = p_expense
          OR EXISTS (SELECT 1 FROM books_fixed_asset_funding x
                      WHERE x.asset_id = f.id AND x.expense_id = p_expense AND x.replaced_at IS NULL))
   ORDER BY f.created_at, f.id
   LIMIT 1
$$;
COMMENT ON FUNCTION books_expense_fixed_asset(uuid) IS
  '10/13 (Nic): the live fixed asset an expense is part of — made from it (source_expense_id) or named by a live funding line — or NULL.';

-- What a loan's money paid for on the live assets: their lines naming it,
-- and the whole cost of an asset that named it alone (funded_loan_id).
CREATE OR REPLACE FUNCTION books_loan_used_by_assets(p_loan uuid) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT sum(x.amount) FROM books_fixed_asset_funding x
                     JOIN books_fixed_assets f ON f.id = x.asset_id AND f.voided_at IS NULL
                    WHERE x.loan_id = p_loan AND x.replaced_at IS NULL), 0)
       + COALESCE((SELECT sum(f.cost) FROM books_fixed_assets f
                    WHERE f.funded_loan_id = p_loan AND f.funded_by = 'loan' AND f.voided_at IS NULL), 0)
$$;

-- What is wrong with how a loan's money is spread over assets, or NULL.
CREATE OR REPLACE FUNCTION books_loan_funding_problem(p_loan uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT format('The loan "%s" lent %s, and the fixed assets it paid for add up to %s. Lower what the assets say came from it, or check the amount borrowed.',
                l.name, to_char(l.original_amount, 'FM$999,999,990.00'), to_char(books_loan_used_by_assets(l.id), 'FM$999,999,990.00'))
    FROM books_loans l
   WHERE l.id = p_loan AND books_loan_used_by_assets(l.id) > l.original_amount
$$;

-- What is wrong with an asset's funding lines, or NULL.
CREATE OR REPLACE FUNCTION books_fixed_asset_funding_problem(p_asset uuid) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  a record;
  total numeric;
  bad record;
  msg text;
BEGIN
  SELECT f.id, f.name, f.cost, f.landlord_id, f.voided_at, f.funded_by, f.funded_loan_id, f.source_expense_id, f.property_id
    INTO a FROM books_fixed_assets f WHERE f.id = p_asset;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM books_fixed_asset_funding x WHERE x.asset_id = p_asset AND x.replaced_at IS NULL) THEN
      RETURN format('A funding line names fixed asset %s, which is not on the books.', p_asset);
    END IF;
    RETURN NULL;
  END IF;
  IF a.voided_at IS NOT NULL THEN RETURN NULL; END IF;
  SELECT sum(x.amount) INTO total FROM books_fixed_asset_funding x WHERE x.asset_id = a.id AND x.replaced_at IS NULL;
  IF total IS NULL THEN RETURN NULL; END IF;
  IF a.funded_by IS NOT NULL OR a.funded_loan_id IS NOT NULL OR a.source_expense_id IS NOT NULL THEN
    RETURN format('The fixed asset "%s" says where its money came from once, as a list.', a.name);
  END IF;
  IF total <> a.cost THEN
    RETURN format('Where the money for "%s" came from adds up to %s, and it cost %s. The amounts must add up to what it cost.',
                  a.name, to_char(total, 'FM$999,999,990.00'), to_char(a.cost, 'FM$999,999,990.00'));
  END IF;
  IF EXISTS (SELECT 1 FROM books_fixed_asset_funding x WHERE x.asset_id = a.id AND x.replaced_at IS NULL
                AND x.landlord_id IS DISTINCT FROM a.landlord_id) THEN
    RETURN format('Where the money for "%s" came from must be its own company''s.', a.name);
  END IF;
  FOR bad IN SELECT DISTINCT x.loan_id FROM books_fixed_asset_funding x
              WHERE x.asset_id = a.id AND x.replaced_at IS NULL AND x.loan_id IS NOT NULL LOOP
    msg := books_loan_funding_problem(bad.loan_id);
    IF msg IS NOT NULL THEN RETURN msg; END IF;
  END LOOP;
  SELECT e.id, e.amount, x.amount AS line, e.description,
         (SELECT count(*) FROM books_fixed_asset_funding y WHERE y.asset_id = a.id AND y.replaced_at IS NULL AND y.expense_id = e.id) AS lines_here,
         EXISTS (SELECT 1 FROM books_fixed_assets g
                  WHERE g.id <> a.id AND g.voided_at IS NULL
                    AND (g.source_expense_id = e.id
                         OR EXISTS (SELECT 1 FROM books_fixed_asset_funding z
                                     WHERE z.asset_id = g.id AND z.expense_id = e.id AND z.replaced_at IS NULL))) AS elsewhere
    INTO bad
    FROM books_fixed_asset_funding x JOIN landlord_expenses e ON e.id = x.expense_id
   WHERE x.asset_id = a.id AND x.replaced_at IS NULL
     AND (x.amount <> e.amount OR e.landlord_id IS DISTINCT FROM a.landlord_id
          OR (SELECT count(*) FROM books_fixed_asset_funding y WHERE y.asset_id = a.id AND y.replaced_at IS NULL AND y.expense_id = e.id) > 1
          OR EXISTS (SELECT 1 FROM books_fixed_assets g
                      WHERE g.id <> a.id AND g.voided_at IS NULL
                        AND (g.source_expense_id = e.id
                             OR EXISTS (SELECT 1 FROM books_fixed_asset_funding z
                                         WHERE z.asset_id = g.id AND z.expense_id = e.id AND z.replaced_at IS NULL))))
   LIMIT 1;
  IF FOUND THEN
    IF bad.elsewhere THEN RETURN format('The expense "%s" is already part of another fixed asset.', COALESCE(bad.description, 'chosen')); END IF;
    IF bad.lines_here > 1 THEN RETURN format('The expense "%s" is named twice for "%s".', COALESCE(bad.description, 'chosen'), a.name); END IF;
    RETURN format('An expense counts toward a fixed asset whole: the expense "%s" is %s.', COALESCE(bad.description, 'chosen'),
                  to_char(bad.amount, 'FM$999,999,990.00'));
  END IF;
  IF EXISTS (SELECT 1 FROM books_fixed_asset_funding x WHERE x.asset_id = a.id AND x.replaced_at IS NULL AND x.expense_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM landlord_expenses e WHERE e.id = x.expense_id)) THEN
    RETURN format('Where the money for "%s" came from names an expense that is not on the books.', a.name);
  END IF;
  -- 10/13 review: an expense pays for part of an asset only where the asset is.
  SELECT e.description INTO bad
    FROM books_fixed_asset_funding x JOIN landlord_expenses e ON e.id = x.expense_id
   WHERE x.asset_id = a.id AND x.replaced_at IS NULL
     AND COALESCE((SELECT u.property_id FROM units u WHERE u.id = e.unit_id), e.property_id) IS DISTINCT FROM a.property_id
   LIMIT 1;
  IF FOUND THEN
    RETURN format('The expense "%s" is not filed where the fixed asset "%s" goes. An expense pays for part of an asset only where the asset is.',
                  COALESCE(bad.description, 'chosen'), a.name);
  END IF;
  IF EXISTS (SELECT 1 FROM books_fixed_asset_funding x WHERE x.asset_id = a.id AND x.replaced_at IS NULL AND x.loan_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM books_loans l WHERE l.id = x.loan_id AND l.landlord_id = a.landlord_id)) THEN
    RETURN format('Where the money for "%s" came from names a loan that is not this company''s.', a.name);
  END IF;
  RETURN NULL;
END $$;

-- Checked at commit: an edit replaces lines and changes the cost in one go.
CREATE OR REPLACE FUNCTION books_fixed_asset_funding_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  msg text;
BEGIN
  IF TG_TABLE_NAME = 'books_loans' THEN
    msg := books_loan_funding_problem(NEW.id);
  ELSIF TG_TABLE_NAME = 'books_fixed_assets' THEN
    msg := books_fixed_asset_funding_problem(NEW.id);
    IF msg IS NULL AND NEW.funded_loan_id IS NOT NULL THEN
      msg := books_loan_funding_problem(NEW.funded_loan_id);
    END IF;
  ELSE
    msg := books_fixed_asset_funding_problem(NEW.asset_id);
  END IF;
  IF msg IS NOT NULL THEN
    RAISE EXCEPTION '%', msg USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS books_fixed_asset_funding_check ON books_fixed_asset_funding;
CREATE CONSTRAINT TRIGGER books_fixed_asset_funding_check AFTER INSERT OR UPDATE ON books_fixed_asset_funding
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION books_fixed_asset_funding_check();
DROP TRIGGER IF EXISTS books_fixed_assets_funding_check ON books_fixed_assets;
CREATE CONSTRAINT TRIGGER books_fixed_assets_funding_check AFTER INSERT OR UPDATE OF cost, voided_at, funded_by, funded_loan_id, property_id ON books_fixed_assets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION books_fixed_asset_funding_check();
DROP TRIGGER IF EXISTS books_loans_funding_check ON books_loans;
CREATE CONSTRAINT TRIGGER books_loans_funding_check AFTER UPDATE OF original_amount ON books_loans
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION books_fixed_asset_funding_check();

-- The expense an asset stands on stays (20261014190300), now also one a live
-- funding line names — and that one's amount stays too (the line is its
-- whole amount), and its place (10/13 review: it is filed where the asset goes).
CREATE OR REPLACE FUNCTION landlord_expenses_asset_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  a record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- 10/13 review: an expense an asset stands on is never removed (a line
    -- naming a missing expense would drop that part of the asset's cost).
    SELECT f.name INTO a FROM books_fixed_assets f WHERE f.id = books_expense_fixed_asset(OLD.id);
    IF FOUND THEN
      RAISE EXCEPTION 'This expense is part of the fixed asset "%", so it is never removed. Void the asset, or change where its money came from, on the Fixed assets page first.', a.name
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.status IS DISTINCT FROM 'active' OR NEW.voided_at IS NOT NULL)
     AND OLD.status = 'active' AND OLD.voided_at IS NULL THEN
    SELECT f.name INTO a FROM books_fixed_assets f WHERE f.source_expense_id = NEW.id AND f.voided_at IS NULL LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'This expense became the fixed asset "%". Void the asset on the Fixed assets page first.', a.name
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW.status IS DISTINCT FROM 'active' OR NEW.voided_at IS NOT NULL OR NEW.amount IS DISTINCT FROM OLD.amount
      OR NEW.property_id IS DISTINCT FROM OLD.property_id OR NEW.unit_id IS DISTINCT FROM OLD.unit_id)
     AND OLD.status = 'active' AND OLD.voided_at IS NULL THEN
    SELECT f.name INTO a FROM books_fixed_assets f
      JOIN books_fixed_asset_funding x ON x.asset_id = f.id AND x.expense_id = NEW.id AND x.replaced_at IS NULL
     WHERE f.voided_at IS NULL LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'This expense paid for part of the fixed asset "%". Change where that asset''s money came from on the Fixed assets page first.', a.name
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS landlord_expenses_asset_guard ON landlord_expenses;
CREATE TRIGGER landlord_expenses_asset_guard BEFORE UPDATE OF status, voided_at, amount, property_id, unit_id ON landlord_expenses
  FOR EACH ROW EXECUTE FUNCTION landlord_expenses_asset_guard();
DROP TRIGGER IF EXISTS landlord_expenses_asset_delete_guard ON landlord_expenses;
CREATE TRIGGER landlord_expenses_asset_delete_guard BEFORE DELETE ON landlord_expenses
  FOR EACH ROW EXECUTE FUNCTION landlord_expenses_asset_guard();

-- A loan an asset stands on (20261015190100), now also one a live funding line
-- names: not voided, its money's destination unchanged, its day on the
-- asset's side of the books start.
CREATE OR REPLACE FUNCTION books_loans_asset_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  a record;
BEGIN
  IF (NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL) OR NEW.funded_to IS DISTINCT FROM OLD.funded_to THEN
    SELECT f.name INTO a FROM books_fixed_assets f
     WHERE f.voided_at IS NULL
       AND (f.funded_loan_id = NEW.id
            OR EXISTS (SELECT 1 FROM books_fixed_asset_funding x WHERE x.asset_id = f.id AND x.loan_id = NEW.id AND x.replaced_at IS NULL))
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'This loan paid for the fixed asset "%". Void the asset on the Fixed assets page first.', a.name
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.start_date IS DISTINCT FROM OLD.start_date THEN
    SELECT f.name, f.acquired_on, x.books_start_date INTO a
      FROM books_fixed_assets f JOIN landlords x ON x.id = f.landlord_id
     WHERE f.voided_at IS NULL AND x.books_start_date IS NOT NULL
       AND (f.funded_loan_id = NEW.id
            OR EXISTS (SELECT 1 FROM books_fixed_asset_funding y WHERE y.asset_id = f.id AND y.loan_id = NEW.id AND y.replaced_at IS NULL))
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

-- The books start does not move between an asset and the loan that paid for
-- it (20261015190100), nor past an asset whose loan or expense lines carry
-- part of its cost (it would open at its whole cost as well), nor past such a
-- loan.
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
  SELECT f.name AS asset_name, f.acquired_on, l.name AS loan_name, l.start_date INTO a
    FROM books_fixed_assets f
    JOIN books_fixed_asset_funding x ON x.asset_id = f.id AND x.replaced_at IS NULL AND x.kind IN ('loan', 'expense')
    LEFT JOIN books_loans l ON l.id = x.loan_id
   WHERE f.landlord_id = NEW.id AND f.voided_at IS NULL
     AND (f.acquired_on < NEW.books_start_date OR l.start_date < NEW.books_start_date)
   ORDER BY f.acquired_on, f.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Your books cannot start on %: the fixed asset "%" (bought on %) was paid for in part by %, which would then be before your books start, so part of its cost would count twice. Change where that asset''s money came from first.',
      NEW.books_start_date, a.asset_name, a.acquired_on,
      CASE WHEN a.loan_name IS NOT NULL THEN format('the loan "%s" (made on %s)', a.loan_name, a.start_date) ELSE 'an expense' END
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ── The ledger capture (LEDGER_CAPTURE_COLUMNS in packages/shared) ──────────
SELECT ledger_install_capture('books_fixed_asset_funding',
  ARRAY['asset_id', 'landlord_id', 'kind', 'loan_id', 'expense_id', 'amount', 'replaced_at'],
  $k$SELECT 'fixed_asset'::text, r.asset_id::text, r.landlord_id
      UNION ALL
      SELECT 'expense', r.expense_id::text, r.landlord_id
      UNION ALL
      SELECT 'expense_payment', xp.id::text, xp.landlord_id
        FROM landlord_expense_payments xp WHERE xp.expense_id = r.expense_id$k$);

-- As 20261015190100 installed it, plus cost_place and unit_id (20261015230000)
-- and the expenses its funding lines name, with their payments (voiding the
-- asset or changing its class moves where each posts its cost).
SELECT ledger_install_capture('books_fixed_assets',
  ARRAY['landlord_id', 'business_id', 'property_id', 'name', 'asset_class', 'cost', 'salvage_value',
        'acquired_on', 'in_service_date', 'life_years', 'method', 'prior_depreciation', 'source_expense_id', 'voided_at',
        'funded_by', 'funded_loan_id',
        'cost_place', 'unit_id'],
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
        FROM landlord_expense_payments xp WHERE xp.expense_id = r.source_expense_id
      UNION ALL
      SELECT 'expense', x.expense_id::text, r.landlord_id
        FROM books_fixed_asset_funding x WHERE x.asset_id = r.id AND x.expense_id IS NOT NULL
      UNION ALL
      SELECT 'expense_payment', xp.id::text, xp.landlord_id
        FROM books_fixed_asset_funding x JOIN landlord_expense_payments xp ON xp.expense_id = x.expense_id
       WHERE x.asset_id = r.id$k$);

-- Everything installed still matches its table.
SELECT ledger_check_capture();
