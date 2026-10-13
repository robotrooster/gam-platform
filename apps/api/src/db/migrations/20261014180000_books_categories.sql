-- 10/12 (Nic) — GAM BOOKS, PHASE P6: THE COMPANY MAKES ITS OWN CATEGORIES
--
-- Nic, 10/12 (L5): "those all sound like real expenses. just let
-- bookkeeper/landlord create custom labels or categories to charge things off
-- to." No forced expense kinds. A company keeps its own list of categories —
-- money out (expenses) and money in (other income) — names them as it likes,
-- and points each at an account in its fully editable chart of accounts. A
-- category pointed at an equity account ("Owner draw") stays off the Profit &
-- Loss by itself; one pointed at an expense account is a cost of the business.
--
--   books_categories        one row per category of a company (landlord, or a
--                           business for its own books later). The old fixed
--                           lists (EXPENSE_CATEGORIES, OTHER_INCOME_CATEGORIES)
--                           become GAM's starting categories (system_key), not
--                           the only ones. A category is never removed: one
--                           the company stops using is archived (its money
--                           stays where it was filed).
--   books_seed_categories() GAM's starting categories for a company, each with
--                           the posting role it charges to until the company
--                           points it at another account. Mirrors
--                           BOOKS_DEFAULT_EXPENSE_CATEGORIES /
--                           BOOKS_DEFAULT_INCOME_CATEGORIES in
--                           packages/shared/src/booksMoneyOut.ts
--                           (services/booksCategories.test.ts holds them equal).
--   books_account_map       a category's account: map_kind 'expense_category'
--                           or 'income_category', map_value = the category's
--                           id (LEDGER_MAP_KINDS). Until a category has a row
--                           of its own it charges to its default role's
--                           account. A category may point at any account of
--                           the company's chart except one GAM keeps from the
--                           money records (a control account) — the guard
--                           below. ('loan' — the Loans page's per-loan
--                           sub-account — is listed too, so the one list in
--                           the CHECKs matches LEDGER_MAP_KINDS whichever
--                           phase's migration runs last.)
--   books_category_account()       the account a category charges to on a day
--   books_category_account_type()  that account's type today
--   books_category_on_pl()         TRUE when the category is on the Profit &
--                                  Loss (expense category → expense account,
--                                  income category → income account).
--   books_category_on_pl_on()      the same on a given day (the account as it
--                                  stood then); the shared liveExpenseSql
--                                  filter and incomeBasis read it with each
--                                  row's own date.
--   landlord_expenses.category_id / landlord_other_income.category_id
--                           the category a row is filed under. The text column
--                           `category` stays (keep-everything, and the older
--                           reports group by it): a seeded category's own key,
--                           'other' for one the company made. Until the code
--                           that writes category_id ships, a BEFORE INSERT
--                           trigger fills it from the text (seeding the
--                           company's categories the first time), so no row is
--                           ever without one.
--   landlord_merchant_rules.category_id
--                           the category a payer's bank lines file under.
--
-- Backfill: every company that already has expenses, other income or payer
-- rules gets its starting categories, and every row its category_id (from its
-- text). Production on 10/12: 0 expenses, 5 other-income rows, 0 Books bills
-- and transactions. Idempotent.
-- Expand-only; safe before the code ships.
-- Safe drop: the triggers and functions below, the three category_id columns,
-- books_categories; re-create books_account_map_guard and the two map_kind
-- CHECKs from migrations 20261013200200 / 20261013200300.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS books_categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE like the company's other Books lists (a company is never removed
  -- in production; test databases clear companies whole).
  landlord_id   uuid REFERENCES landlords(id) ON DELETE CASCADE,
  business_id   uuid REFERENCES businesses(id) ON DELETE CASCADE,
  direction     text NOT NULL,
  name          text NOT NULL,
  system_key    text,
  default_role  text,
  system_use    text,
  archived_at   timestamptz,
  archived_by   uuid REFERENCES users(id),
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT books_categories_one_owner CHECK (num_nonnulls(landlord_id, business_id) = 1),
  CONSTRAINT books_categories_direction_check CHECK (direction IN ('expense', 'income')),
  CONSTRAINT books_categories_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT books_categories_role_known CHECK (default_role IS NULL OR ledger_account_role_type(default_role) IS NOT NULL),
  CONSTRAINT books_categories_system_use_check CHECK (system_use IS NULL OR system_use IN ('payroll', 'loan', 'fixed_asset')),
  CONSTRAINT books_categories_archived_is_stamped CHECK (archived_by IS NULL OR archived_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS books_categories_landlord_key
  ON books_categories (landlord_id, direction, system_key) WHERE system_key IS NOT NULL AND landlord_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS books_categories_business_key
  ON books_categories (business_id, direction, system_key) WHERE system_key IS NOT NULL AND business_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS books_categories_landlord_name
  ON books_categories (landlord_id, direction, lower(btrim(name))) WHERE archived_at IS NULL AND landlord_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS books_categories_business_name
  ON books_categories (business_id, direction, lower(btrim(name))) WHERE archived_at IS NULL AND business_id IS NOT NULL;

COMMENT ON TABLE books_categories IS
  '10/12 (Nic, L5): the categories a company files money out (expenses) and money in (other income) under — its own list, GAM''s starting ones (system_key) included. Each points at an account through books_account_map (expense_category / income_category). Never deleted; archived when no longer used.';
COMMENT ON COLUMN books_categories.default_role IS
  '10/12 (ledger P6): the posting role whose account the category charges to until the company points it at an account of its own (books_account_map). NULL = the direction''s fallback (other expenses / other income). Never changes.';

-- A category's direction, owner and default role never change (its money and
-- its account mapping are keyed by them); its name and archived state may. No
-- route removes one (it is archived, and rows filed under it keep it).
CREATE OR REPLACE FUNCTION books_categories_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.direction IS DISTINCT FROM OLD.direction OR NEW.landlord_id IS DISTINCT FROM OLD.landlord_id
     OR NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.default_role IS DISTINCT FROM OLD.default_role
     OR NEW.system_key IS DISTINCT FROM OLD.system_key OR NEW.system_use IS DISTINCT FROM OLD.system_use THEN
    RAISE EXCEPTION 'A category''s direction, company and starting account never change; make a new category instead.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS books_categories_guard ON books_categories;
CREATE TRIGGER books_categories_guard BEFORE UPDATE ON books_categories
  FOR EACH ROW EXECUTE FUNCTION books_categories_guard();

DROP TRIGGER IF EXISTS audit_books_categories ON books_categories;
CREATE TRIGGER audit_books_categories AFTER DELETE OR UPDATE ON books_categories
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- ── GAM's starting categories (BOOKS_DEFAULT_*_CATEGORIES) ──────────────────
CREATE OR REPLACE FUNCTION books_seed_categories(p_landlord uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  IF p_landlord IS NULL THEN RETURN 0; END IF;
  INSERT INTO books_categories (landlord_id, direction, name, system_key, default_role, system_use)
  SELECT p_landlord, s.direction, s.name, s.key, s.role, s.system_use
    FROM (VALUES
      ('expense', 'maintenance',           'Maintenance',                'repairs_maintenance',    NULL::text, 1),
      ('expense', 'repairs',               'Repairs',                    'repairs_maintenance',    NULL, 2),
      ('expense', 'utilities',             'Utilities',                  'utilities_expense',      NULL, 3),
      ('expense', 'insurance',             'Insurance',                  'insurance',              NULL, 4),
      ('expense', 'property_tax',          'Property tax',               'property_taxes',         NULL, 5),
      ('expense', 'management',            'Management',                 'management_fees',        NULL, 6),
      ('expense', 'supplies',              'Supplies',                   'supplies',               NULL, 7),
      ('expense', 'landscaping',           'Landscaping',                'landscaping',            NULL, 8),
      ('expense', 'professional',          'Legal / professional',       'professional_fees',      NULL, 9),
      ('expense', 'mortgage_interest',     'Mortgage interest',          'mortgage_interest',      NULL, 10),
      ('expense', 'hoa',                   'HOA',                        'hoa_fees',               NULL, 11),
      ('expense', 'advertising',           'Advertising',                'advertising',            NULL, 12),
      ('expense', 'lot_rent',              'Lot rent',                   'lot_rent_expense',       NULL, 13),
      ('expense', 'bank_fees',             'Bank fees / charges',        'bank_fees',              NULL, 14),
      ('expense', 'other',                 'Other',                      'other_expenses',         NULL, 15),
      ('expense', 'pest_control',          'Pest control',               'pest_control',           NULL, 16),
      ('expense', 'accounting',            'Accounting and bookkeeping', 'accounting_fees',        NULL, 17),
      ('expense', 'software',              'Software and subscriptions', 'software_subscriptions', NULL, 18),
      ('expense', 'vehicle_travel',        'Vehicle and travel',         'vehicle_travel',         NULL, 19),
      ('expense', 'contractor_payments',   'Contractor payments',        'contractor_payments',    NULL, 20),
      ('expense', 'wages',                 'Wages paid outside payroll', 'payroll_expense',        NULL, 21),
      ('expense', 'owner_draw',            'Owner draw',                 'owner_draws',            NULL, 22),
      ('expense', 'payroll_take_home',     'Payroll: take-home pay',     'net_pay_payable',        'payroll', 23),
      ('expense', 'payroll_taxes',         'Payroll: taxes owed',        'payroll_liabilities',    'payroll', 24),
      ('income',  'laundry',               'Laundry',                    'laundry_vending',        NULL, 101),
      ('income',  'vending',               'Vending',                    'laundry_vending',        NULL, 102),
      ('income',  'storage',               'Storage',                    'storage_fees',           NULL, 103),
      ('income',  'utility_reimbursement', 'Utility reimbursement',      'utility_other',          NULL, 104),
      ('income',  'late_fees',             'Late fees',                  'late_fees',              NULL, 105),
      ('income',  'application_fees',      'Application fees',           'application_fees',       NULL, 106),
      ('income',  'pet_fees',              'Pet fees',                   'pet_fees',               NULL, 107),
      ('income',  'parking',               'Parking',                    'other_income',           NULL, 108),
      ('income',  'propane_fuel',          'Propane / fuel',             'utility_propane',        NULL, 109),
      ('income',  'insurance_claim',       'Insurance claim',            'other_income',           NULL, 110),
      ('income',  'tax_refund',            'Tax refund',                 'other_income',           NULL, 111),
      ('income',  'sale_proceeds',         'Sale proceeds',              'suspense',               NULL, 112),
      ('income',  'owner_contribution',    'Owner contribution',         'owner_equity',           NULL, 113),
      ('income',  'interest',              'Interest earned',            'interest_earned',        NULL, 114),
      ('income',  'other',                 'Other income',               'other_income',           NULL, 115)
    ) AS s(direction, key, name, role, system_use, ord)
   WHERE NOT EXISTS (SELECT 1 FROM books_categories c
                      WHERE c.landlord_id = p_landlord AND c.direction = s.direction AND c.system_key = s.key)
   ORDER BY s.ord
  -- A name the company already gave a category of its own keeps it; GAM's
  -- starting one of the same name is simply not added.
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

COMMENT ON FUNCTION books_seed_categories(uuid) IS
  '10/12 (Nic, L5): adds GAM''s starting categories a company does not have yet (BOOKS_DEFAULT_*_CATEGORIES). Idempotent.';

-- ── The map: categories point at accounts ───────────────────────────────────
ALTER TABLE books_account_map DROP CONSTRAINT IF EXISTS books_account_map_kind_check;
ALTER TABLE books_account_map ADD CONSTRAINT books_account_map_kind_check
  CHECK (map_kind IN ('role', 'bank_connection', 'sales_tax', 'loan', 'expense_category', 'income_category'));

ALTER TABLE ledger_posting_lines DROP CONSTRAINT IF EXISTS ledger_posting_lines_map_kind_check;
ALTER TABLE ledger_posting_lines ADD CONSTRAINT ledger_posting_lines_map_kind_check
  CHECK (map_kind IS NULL OR map_kind IN ('role', 'bank_connection', 'sales_tax', 'loan', 'expense_category', 'income_category'));

-- The guard of 20261013200200, with the new kinds: a loan's sub-account is a
-- liability; a category may point at any account of its own company's chart
-- (its own category, the right direction) except one a control role (an
-- account GAM keeps from the money records) uses or ever used.
CREATE OR REPLACE FUNCTION books_account_map_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  acct      record;
  expected  text;
  locked_to date;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'books_account_map is the history of where each posting role went; a repoint is a new row, never a change (%).', TG_OP
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT a.landlord_id, a.business_id, a.type, a.active, a.name INTO acct
    FROM books_accounts a WHERE a.id = NEW.account_id;
  IF acct.landlord_id IS DISTINCT FROM NEW.landlord_id OR acct.business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'That account belongs to another company''s chart.' USING ERRCODE = 'check_violation';
  END IF;
  IF acct.active IS FALSE THEN
    RAISE EXCEPTION '% is retired. Choose an active account.', acct.name USING ERRCODE = 'check_violation';
  END IF;
  expected := CASE NEW.map_kind
                WHEN 'role' THEN ledger_account_role_type(NEW.map_value)
                WHEN 'bank_connection' THEN 'asset'
                WHEN 'sales_tax' THEN 'liability'
                WHEN 'loan' THEN 'liability'
                WHEN 'expense_category' THEN '*'
                WHEN 'income_category' THEN '*'
              END;
  IF expected IS NULL THEN
    RAISE EXCEPTION '% is not a posting role the books use.', NEW.map_value USING ERRCODE = 'check_violation';
  END IF;
  IF expected = '*' THEN
    IF NOT EXISTS (SELECT 1 FROM books_categories c
                    WHERE c.id::text = NEW.map_value
                      AND c.direction = CASE NEW.map_kind WHEN 'expense_category' THEN 'expense' ELSE 'income' END
                      AND c.landlord_id IS NOT DISTINCT FROM NEW.landlord_id
                      AND c.business_id IS NOT DISTINCT FROM NEW.business_id) THEN
      RAISE EXCEPTION 'That category is not one of this company''s.' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM books_account_map m
                WHERE m.account_id = NEW.account_id AND m.map_kind = 'role' AND ledger_account_role_is_control(m.map_value)) THEN
      RAISE EXCEPTION '% is kept by GAM from the money records. Choose another account for this category.', acct.name
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF acct.type IS DISTINCT FROM expected THEN
    RAISE EXCEPTION '% is an % account; this needs an % account.', acct.name, acct.type, expected
      USING ERRCODE = 'check_violation';
  END IF;
  -- The first row for a key may cover all history; a repoint never reaches
  -- into a closed month. 10/12 review: nor does a category's starting role
  -- history written down as its own (services/booksCategories pointCategory,
  -- the first time a category that already posted is pointed): each copy is
  -- one of that role's own rows, the same account from the same day, and every
  -- row the category has so far is such a copy — so the category charges
  -- exactly where it always did on every day, closed months included.
  IF expected = '*' AND EXISTS (
       SELECT 1 FROM books_categories c
         JOIN books_account_map r
           ON r.map_kind = 'role'
          AND r.map_value = COALESCE(c.default_role, CASE c.direction WHEN 'expense' THEN 'other_expenses' ELSE 'other_income' END)
          AND r.landlord_id IS NOT DISTINCT FROM NEW.landlord_id AND r.business_id IS NOT DISTINCT FROM NEW.business_id
          AND r.account_id = NEW.account_id AND r.effective_from = NEW.effective_from
        WHERE c.id::text = NEW.map_value)
     AND NOT EXISTS (
       SELECT 1 FROM books_account_map m
        WHERE m.map_kind = NEW.map_kind AND m.map_value = NEW.map_value
          AND m.landlord_id IS NOT DISTINCT FROM NEW.landlord_id AND m.business_id IS NOT DISTINCT FROM NEW.business_id
          AND NOT EXISTS (
            SELECT 1 FROM books_categories c2
              JOIN books_account_map r2
                ON r2.map_kind = 'role'
               AND r2.map_value = COALESCE(c2.default_role, CASE c2.direction WHEN 'expense' THEN 'other_expenses' ELSE 'other_income' END)
               AND r2.landlord_id IS NOT DISTINCT FROM m.landlord_id AND r2.business_id IS NOT DISTINCT FROM m.business_id
               AND r2.account_id = m.account_id AND r2.effective_from = m.effective_from
             WHERE c2.id::text = m.map_value)) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM books_account_map m
              WHERE m.map_kind = NEW.map_kind AND m.map_value = NEW.map_value
                AND ((NEW.landlord_id IS NOT NULL AND m.landlord_id = NEW.landlord_id)
                     OR (NEW.business_id IS NOT NULL AND m.business_id = NEW.business_id))) THEN
    locked_to := ledger_closed_through(NEW.landlord_id, NEW.business_id);
    IF locked_to IS NOT NULL AND NEW.effective_from <= locked_to THEN
      RAISE EXCEPTION 'The books are closed through %; a repoint takes effect after that.', locked_to
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ── Where a category's money goes ───────────────────────────────────────────
-- The account a category charges to on p_day: its own map row in force that
-- day (the earliest one for a day before any), else its default role's (or
-- the direction's fallback role's) account in force that day. NULL when the
-- company's chart is not set up yet.
CREATE OR REPLACE FUNCTION books_category_account(p_category uuid, p_day date) RETURNS uuid
LANGUAGE sql STABLE AS $$
  WITH c AS (
    SELECT id, landlord_id, business_id,
           CASE direction WHEN 'expense' THEN 'expense_category' ELSE 'income_category' END AS kind,
           COALESCE(default_role, CASE direction WHEN 'expense' THEN 'other_expenses' ELSE 'other_income' END) AS role
      FROM books_categories WHERE id = p_category)
  SELECT COALESCE(
    (SELECT m.account_id FROM books_account_map m, c
      WHERE m.map_kind = c.kind AND m.map_value = c.id::text
        AND m.landlord_id IS NOT DISTINCT FROM c.landlord_id AND m.business_id IS NOT DISTINCT FROM c.business_id
      ORDER BY (m.effective_from <= p_day) DESC,
               CASE WHEN m.effective_from <= p_day THEN m.effective_from END DESC NULLS LAST,
               m.effective_from, m.id DESC
      LIMIT 1),
    (SELECT m.account_id FROM books_account_map m, c
      WHERE m.map_kind = 'role' AND m.map_value = c.role
        AND m.landlord_id IS NOT DISTINCT FROM c.landlord_id AND m.business_id IS NOT DISTINCT FROM c.business_id
      ORDER BY (m.effective_from <= p_day) DESC,
               CASE WHEN m.effective_from <= p_day THEN m.effective_from END DESC NULLS LAST,
               m.effective_from, m.id DESC
      LIMIT 1))
$$;

-- The type of account a category charges to today; before the company's chart
-- is set up, its starting role's type.
CREATE OR REPLACE FUNCTION books_category_account_type(p_category uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT a.type FROM books_accounts a WHERE a.id = books_category_account(p_category, CURRENT_DATE)),
    (SELECT ledger_account_role_type(COALESCE(c.default_role,
              CASE c.direction WHEN 'expense' THEN 'other_expenses' ELSE 'other_income' END))
       FROM books_categories c WHERE c.id = p_category))
$$;

-- The type of account a category charges to on p_day (what its money was
-- that day — the ledger's money-out lines carry it, MONEY_OUT_LINE_KINDS);
-- before the company's chart is set up, its starting role's type.
CREATE OR REPLACE FUNCTION books_category_account_type_on(p_category uuid, p_day date) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT a.type FROM books_accounts a WHERE a.id = books_category_account(p_category, p_day)),
    (SELECT ledger_account_role_type(COALESCE(c.default_role,
              CASE c.direction WHEN 'expense' THEN 'other_expenses' ELSE 'other_income' END))
       FROM books_categories c WHERE c.id = p_category))
$$;

-- TRUE when the category is on the Profit & Loss: an expense category on an
-- expense account, an income category on an income account
-- (BOOKS_CATEGORY_PL_TYPE). A row with no category (never, after the backfill)
-- reads as on it, the way it always did.
CREATE OR REPLACE FUNCTION books_category_on_pl(p_category uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_category IS NULL THEN TRUE
              ELSE COALESCE((SELECT books_category_account_type(c.id) = c.direction
                               FROM books_categories c WHERE c.id = p_category), TRUE) END
$$;

COMMENT ON FUNCTION books_category_on_pl(uuid) IS
  '10/12 (Nic, L5): TRUE when a category''s money counts on the Profit & Loss (its account is an expense account for money out, an income account for money in). An owner draw on equity, payroll''s take-home pay on a liability: real money, not a cost.';

-- 10/12 review: the same, as the category's account stood ON A DAY — what a
-- row dated that day was (the ledger's rule: a repoint takes effect from its
-- day, history stays where it was). The P&L readers outside the ledger
-- (liveExpenseSql, incomeBasis) judge each row by its own date, so pointing a
-- used category at a balance-sheet account never takes its past (closed months
-- included) off those screens while the ledger keeps it.
CREATE OR REPLACE FUNCTION books_category_on_pl_on(p_category uuid, p_day date) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_category IS NULL THEN TRUE
              ELSE COALESCE((SELECT books_category_account_type_on(c.id, COALESCE(p_day, CURRENT_DATE)) = c.direction
                               FROM books_categories c WHERE c.id = p_category), TRUE) END
$$;

COMMENT ON FUNCTION books_category_on_pl_on(uuid, date) IS
  '10/12 review: books_category_on_pl as the category''s account stood on p_day — how a row dated that day counts on a Profit & Loss outside the ledger.';

-- ── The rows' categories ────────────────────────────────────────────────────
ALTER TABLE landlord_expenses     ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES books_categories(id);
ALTER TABLE landlord_other_income ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES books_categories(id);
ALTER TABLE landlord_merchant_rules ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES books_categories(id);
CREATE INDEX IF NOT EXISTS landlord_expenses_category ON landlord_expenses (category_id) WHERE category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS landlord_other_income_category ON landlord_other_income (category_id) WHERE category_id IS NOT NULL;

COMMENT ON COLUMN landlord_expenses.category_id IS
  '10/12 (Nic, L5): the company''s category this expense is filed under (books_categories). category (text) keeps the older reports'' word: the seeded key, else ''other''.';
COMMENT ON COLUMN landlord_other_income.category_id IS
  '10/12 (Nic, L5): the company''s category this money in is filed under (books_categories).';

-- The category of a row written without one (a writer from before 10/12):
-- the company's seeded category of the same key, else its "Other".
CREATE OR REPLACE FUNCTION books_fill_category_id() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  dir text := CASE TG_TABLE_NAME WHEN 'landlord_other_income' THEN 'income' ELSE 'expense' END;
BEGIN
  IF NEW.category_id IS NOT NULL OR NEW.landlord_id IS NULL THEN RETURN NEW; END IF;
  PERFORM books_seed_categories(NEW.landlord_id);
  SELECT c.id INTO NEW.category_id FROM books_categories c
   WHERE c.landlord_id = NEW.landlord_id AND c.direction = dir
     AND c.system_key = COALESCE(NULLIF(NEW.category, ''), 'other');
  IF NEW.category_id IS NULL THEN
    SELECT c.id INTO NEW.category_id FROM books_categories c
     WHERE c.landlord_id = NEW.landlord_id AND c.direction = dir AND c.system_key = 'other';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS landlord_expenses_fill_category ON landlord_expenses;
CREATE TRIGGER landlord_expenses_fill_category BEFORE INSERT ON landlord_expenses
  FOR EACH ROW WHEN (NEW.category_id IS NULL) EXECUTE FUNCTION books_fill_category_id();
DROP TRIGGER IF EXISTS landlord_other_income_fill_category ON landlord_other_income;
CREATE TRIGGER landlord_other_income_fill_category BEFORE INSERT ON landlord_other_income
  FOR EACH ROW WHEN (NEW.category_id IS NULL) EXECUTE FUNCTION books_fill_category_id();

-- ── Backfill ────────────────────────────────────────────────────────────────
SELECT books_seed_categories(x.landlord_id)
  FROM (SELECT landlord_id FROM landlord_expenses
        UNION SELECT landlord_id FROM landlord_other_income
        UNION SELECT landlord_id FROM landlord_merchant_rules
        UNION SELECT landlord_id FROM books_bills WHERE landlord_id IS NOT NULL
        UNION SELECT landlord_id FROM books_transactions WHERE landlord_id IS NOT NULL) x
 WHERE x.landlord_id IS NOT NULL;

UPDATE landlord_expenses e
   SET category_id = COALESCE(
         (SELECT c.id FROM books_categories c WHERE c.landlord_id = e.landlord_id AND c.direction = 'expense' AND c.system_key = e.category),
         (SELECT c.id FROM books_categories c WHERE c.landlord_id = e.landlord_id AND c.direction = 'expense' AND c.system_key = 'other'))
 WHERE e.category_id IS NULL;

UPDATE landlord_other_income o
   SET category_id = COALESCE(
         (SELECT c.id FROM books_categories c WHERE c.landlord_id = o.landlord_id AND c.direction = 'income' AND c.system_key = o.category),
         (SELECT c.id FROM books_categories c WHERE c.landlord_id = o.landlord_id AND c.direction = 'income' AND c.system_key = 'other'))
 WHERE o.category_id IS NULL;

-- A payer rule's category: money out rules by the expense list, money in by
-- the income list, whichever has the key (an expense key first: most rules are
-- money out; last_direction says which when it is known).
UPDATE landlord_merchant_rules r
   SET category_id = COALESCE(
         (SELECT c.id FROM books_categories c WHERE c.landlord_id = r.landlord_id AND c.system_key = r.category
             AND c.direction = CASE WHEN r.last_direction = 'in' THEN 'income' ELSE 'expense' END),
         (SELECT c.id FROM books_categories c WHERE c.landlord_id = r.landlord_id AND c.system_key = r.category
             AND c.direction = CASE WHEN r.last_direction = 'in' THEN 'expense' ELSE 'income' END))
 WHERE r.category_id IS NULL;
