-- 10/12 (Nic) — GAM BOOKS LEDGER: "CARD FEES REFUNDED" IS ITS OWN EXPENSE LINE
--
-- Nic, 10/12 (G10): "a refunded card sale gives the fee back and the landlord
-- eats it" — the customer gets the card fee back too, and it shows as the
-- landlord's cost, e.g. a "Card fees refunded" expense line. The ledger posts
-- that fee to its own posting role, card_fees_refunded (seeded as 5117 "Card
-- fees refunded", next to 5115 Processing fees and 5116 Chargeback and return
-- fees), so the Profit & Loss shows it on its own line.
--
-- The posting-role catalog in SQL (ledger_account_role_type, migration
-- 20261013200200) must know the role, or the CHECKs on ledger_posting_lines
-- and books_account_map refuse it. This ADDS the one role to the function as
-- it stands (reading its current definition), so a role another phase adds in
-- its own migration is kept whatever order the two run in. Not a control role
-- (hand journal lines may use it), so ledger_account_role_is_control is
-- unchanged. services/ledgerCoverage.test.ts holds the function equal to
-- LEDGER_ACCOUNT_ROLE_DEFS in packages/shared/src/booksLedger.ts.
--
-- The ledger is DARK: ensureChart seeds the account the first time a company
-- posts (it re-seeds any role a later release adds).
-- Expand-only. No backfill needed.
-- Safe drop: re-create ledger_account_role_type without the
-- 'card_fees_refunded' branch (only once no line or map row names the role).

SET LOCAL lock_timeout = '10s';

DO $role$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('ledger_account_role_type(text)'::regprocedure);
  IF position($q$'card_fees_refunded'$q$ IN def) = 0 THEN
    IF position('ELSE NULL END' IN def) = 0 THEN
      RAISE EXCEPTION 'ledger_account_role_type() no longer ends in ELSE NULL END; add card_fees_refunded by hand';
    END IF;
    def := replace(def, 'ELSE NULL END', $q$WHEN 'card_fees_refunded' THEN 'expense'
    ELSE NULL END$q$);
    EXECUTE def;
  END IF;
END $role$;

DO $check$
BEGIN
  IF ledger_account_role_type('card_fees_refunded') IS DISTINCT FROM 'expense' THEN
    RAISE EXCEPTION 'card_fees_refunded did not reach the posting-role catalog';
  END IF;
  IF ledger_account_role_is_control('card_fees_refunded') THEN
    RAISE EXCEPTION 'card_fees_refunded must not be a control role';
  END IF;
END $check$;
