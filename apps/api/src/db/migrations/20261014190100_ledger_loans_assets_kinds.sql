-- 10/12 (Nic) — GAM BOOKS LEDGER: WHAT LOANS AND FIXED ASSETS POST AS
--
-- Nic, 10/12: loans (each payment split into principal / interest / escrow)
-- and fixed assets with depreciation are part of this build. Three things the
-- ledger's own lists did not have yet (the values match packages/shared/src/
-- booksLedger.ts; services/ledgerCoverage.test.ts holds them together):
--
--   1. Source types (ledger_postings.source_type):
--        'loan'          a loan: the money it put on the books when it was
--                        made, or what was still owed on the books start date
--        'loan_payment'  one loan payment: principal off the loan, interest an
--                        expense, escrow to the money the lender holds
--        'fixed_asset'   a fixed asset: '<asset id>' its opening (an asset
--                        owned before the books start), '<asset id>|YYYY-MM'
--                        that month's depreciation
--   2. The posting role 'loan_escrow' (seeded as 1250 "Escrow held by your
--      lender", an asset): the escrow part of each loan payment — money the
--      lender holds to pay property tax and insurance.
--   3. The map kind 'loan' (books_account_map / ledger_posting_lines.map_kind):
--      each loan gets its own sub-account under Mortgage payable (2100), so
--      the balance sheet shows what is owed on each loan. Migration
--      20261014180000 (money out) already lists it in both CHECKs and in
--      books_account_map_guard (a loan's sub-account is a liability); this
--      adds it only if it is missing, so the order the phases ship in never
--      matters.
--
-- Every CHECK is WIDENED, never narrowed, by adding to the values it holds
-- right now; the role is ADDED to ledger_account_role_type() as it stands
-- (reading its current definition), so a role another phase adds in its own
-- migration is kept. 'loan_escrow' is not a control role (a bookkeeper may
-- adjust it by hand: escrow the lender pays out for taxes and insurance is a
-- journal entry today), so ledger_account_role_is_control is unchanged.
--
-- The ledger is DARK in production until the integrate step registers the
-- projectors. Expand-only; safe before the code ships. No backfill needed.
-- Safe drop: re-create ledger_account_role_type without the 'loan_escrow'
-- branch (only once no line or map row names it); the widened CHECK values are
-- unused until something posts them.

SET LOCAL lock_timeout = '10s';

-- ── 1 + 3. Widen the CHECKs (current values ∪ the new ones) ─────────────────
DO $widen$
DECLARE
  spec record;
  cur  text[];
  want text[];
BEGIN
  FOR spec IN SELECT * FROM (VALUES
      ('ledger_postings',      'ledger_postings_source_type_check',   'source_type',
         ARRAY['loan', 'loan_payment', 'fixed_asset'], FALSE),
      ('books_account_map',    'books_account_map_kind_check',        'map_kind', ARRAY['loan'], FALSE),
      ('ledger_posting_lines', 'ledger_posting_lines_map_kind_check', 'map_kind', ARRAY['loan'], TRUE)
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

-- ── 3. A loan's sub-account is a liability (books_account_map_guard) ────────
DO $guard$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('books_account_map_guard()'::regprocedure);
  IF position($q$WHEN 'loan' THEN$q$ IN def) = 0 THEN
    IF position($q$WHEN 'sales_tax' THEN 'liability'$q$ IN def) = 0 THEN
      RAISE EXCEPTION 'books_account_map_guard() no longer names the sales_tax kind; add the loan kind (a liability) by hand';
    END IF;
    def := replace(def, $q$WHEN 'sales_tax' THEN 'liability'$q$, $q$WHEN 'sales_tax' THEN 'liability'
                WHEN 'loan' THEN 'liability'$q$);
    EXECUTE def;
  END IF;
END $guard$;

-- ── 2. The escrow role ──────────────────────────────────────────────────────
DO $role$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('ledger_account_role_type(text)'::regprocedure);
  IF position($q$'loan_escrow'$q$ IN def) = 0 THEN
    IF position('ELSE NULL END' IN def) = 0 THEN
      RAISE EXCEPTION 'ledger_account_role_type() no longer ends in ELSE NULL END; add loan_escrow by hand';
    END IF;
    def := replace(def, 'ELSE NULL END', $q$WHEN 'loan_escrow' THEN 'asset'
    ELSE NULL END$q$);
    EXECUTE def;
  END IF;
END $role$;

DO $check$
BEGIN
  IF ledger_account_role_type('loan_escrow') IS DISTINCT FROM 'asset' THEN
    RAISE EXCEPTION 'loan_escrow did not reach the posting-role catalog';
  END IF;
  IF ledger_account_role_is_control('loan_escrow') THEN
    RAISE EXCEPTION 'loan_escrow must not be a control role';
  END IF;
END $check$;
