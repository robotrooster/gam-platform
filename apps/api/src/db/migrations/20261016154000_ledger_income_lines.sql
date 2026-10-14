-- 10/14 (Nic, I1-I7) — GAM BOOKS LEDGER: INCOME ITEMIZED BY SPACE TYPE
--
-- Nic's bookkeeper (via Nic, 10/14): "a breakdown of where it's from, a
-- distinction by unit type for mobile home spaces, the lot rent, any trailer
-- payments that may be made, and RV stays that are long-term versus the
-- short-term taxable ones. right now the RV long-term and the mobile home is
-- all just kind of grouped together in one income batch. we need everything
-- to be as itemized as possible". I1: for EVERY company.
--
-- Rent and stays now book to their own line by the space they are for
-- (packages/shared/src/booksLedger.ts LEDGER_RENT_LINES / LEDGER_STAY_LINES):
-- each line is a sub-account the company's books add the first time it is
-- used (like a linked bank's or a named tax's), so a company only ever sees
-- the lines it has. Two map kinds (books_account_map / ledger_posting_lines
-- .map_kind) carry them:
--
--   'rent_line'  under 4010 Space and lot rent: long-term money (a lease's
--                rent, a stay of 30+ nights, I2) by space type — mobile home
--                lot rent and park-owned trailer rent (I4/I5: derived from
--                the unit's dwelling ownership and lot rent), RV long-term
--                rent, apartments, houses and every other type
--   'stay_line'  under 4400 Stay income: short-term stays (under 30 nights,
--                the taxed ones, I2) by space type
--
-- Both are income accounts (books_account_map_guard). The posting role on
-- each line is unchanged (space_rent / stay_income), so every check and
-- report that reads a role reads the same money; only the account moves.
--
-- Existing postings move by a full rebuild per company at deploy (the
-- projectors' rule versions are bumped). Every CHECK is WIDENED, never
-- narrowed, by adding to the values it holds right now.
-- Expand-only. No backfill here.
-- Safe drop: none needed — the widened values are unused until something
-- posts them.

SET LOCAL lock_timeout = '10s';

-- ── The two map kinds in both CHECKs (current values ∪ the new ones) ────────
DO $widen$
DECLARE
  spec record;
  cur  text[];
  want text[];
BEGIN
  FOR spec IN SELECT * FROM (VALUES
      ('books_account_map',    'books_account_map_kind_check',        'map_kind', ARRAY['rent_line', 'stay_line'], FALSE),
      ('ledger_posting_lines', 'ledger_posting_lines_map_kind_check', 'map_kind', ARRAY['rent_line', 'stay_line'], TRUE)
    ) v(tbl, con, col, adds, nullable)
  LOOP
    SELECT array_agg(m[1] ORDER BY ord) INTO cur
      FROM pg_constraint c
      CROSS JOIN LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') WITH ORDINALITY AS x(m, ord)
     WHERE c.conrelid = spec.tbl::regclass AND c.conname = spec.con;
    IF cur IS NULL THEN
      RAISE EXCEPTION '%.% is missing', spec.tbl, spec.con;
    END IF;
    SELECT array_agg(v ORDER BY first_ord) INTO want FROM (
      SELECT v, min(ord) AS first_ord
        FROM unnest(cur || spec.adds) WITH ORDINALITY AS u(v, ord)
       GROUP BY v) s;
    IF want <> cur THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', spec.tbl, spec.con);
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s%I IN (%s))', spec.tbl, spec.con,
                     CASE WHEN spec.nullable THEN format('%I IS NULL OR ', spec.col) ELSE '' END, spec.col,
                     (SELECT string_agg(quote_literal(v), ', ' ORDER BY o) FROM unnest(want) WITH ORDINALITY AS w(v, o)));
    END IF;
  END LOOP;
END $widen$;

-- ── Each line's sub-account is an income account (books_account_map_guard) ──
DO $guard$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('books_account_map_guard()'::regprocedure);
  IF position($q$WHEN 'rent_line' THEN$q$ IN def) = 0 THEN
    IF position($q$WHEN 'sales_tax' THEN 'liability'$q$ IN def) = 0 THEN
      RAISE EXCEPTION 'books_account_map_guard() no longer names the sales_tax kind; add the rent_line and stay_line kinds (income) by hand';
    END IF;
    def := replace(def, $q$WHEN 'sales_tax' THEN 'liability'$q$, $q$WHEN 'sales_tax' THEN 'liability'
                WHEN 'rent_line' THEN 'income'
                WHEN 'stay_line' THEN 'income'$q$);
    EXECUTE def;
  END IF;
END $guard$;
