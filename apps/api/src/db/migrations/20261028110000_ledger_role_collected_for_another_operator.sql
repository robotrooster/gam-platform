-- 10/27 (Nic) — WHERE A DEBT COLLECTED FOR ANOTHER OPERATOR SITS ON THE BOOKS.
--
-- The second door bills the resident's installment on the COLLECTING
-- landlord's invoice, because that is the invoice the resident gets. So the
-- money passes through their books, and it is never their income — it is the
-- other operator's money, held for the few days until the weekly payout moves
-- it (held item 'left_owing_netted' off this landlord, 'left_owing_paid' to
-- the one owed).
--
-- Without a liability to hold it, the existing carried-balance branch would
-- have credited OPENING BALANCE EQUITY (A8, "a balance from before GAM") —
-- which would say this landlord got richer by another operator's debt, and
-- their equity would be overstated by every installment the resident paid.
--
-- So: receivable from the resident, liability to the operator, and the two
-- cancel as the money arrives and leaves. No income either side, which matches
-- how GAM Books already treats a carried balance: "The money was already
-- earned and already reported, in its own months" (A8b).
--
-- A CONTROL ROLE. The balance follows from the arrangement
-- (left_owing_collections) and from nothing else, so a hand journal line must
-- not be able to touch it — ledger_account_role_is_control() is what refuses
-- one.
--
-- The posting-role catalog in SQL (ledger_account_role_type +
-- ledger_account_role_is_control, migration 20261013200200) must know the role
-- or the CHECKs on ledger_posting_lines and books_account_map refuse it. Both
-- functions are read as they stand and the one branch added, so a role another
-- phase adds in its own migration survives whatever order the two run in.
-- services/ledgerCoverage.test.ts holds the functions equal to
-- LEDGER_ACCOUNT_ROLE_DEFS in packages/shared/src/booksLedger.ts.
--
-- ensureChart seeds the account the next time a company posts (it re-seeds any
-- role a later release adds).
-- Expand-only. NO BACKFILL NEEDED: no arrangement exists yet, so nothing has
-- been posted to the wrong account.
-- Safe drop: re-create both functions without the branch, once no posting line
-- or account-map row names the role.

SET LOCAL lock_timeout = '10s';

DO $role$
DECLARE
  def text;
  r   text := 'collected_for_another_operator';
BEGIN
  def := pg_get_functiondef('ledger_account_role_type(text)'::regprocedure);
  IF position(quote_literal(r) IN def) = 0 THEN
    IF position('ELSE NULL END' IN def) = 0 THEN
      RAISE EXCEPTION 'ledger_account_role_type() no longer ends in ELSE NULL END; add % by hand', r;
    END IF;
    def := replace(def, 'ELSE NULL END', format('WHEN %L THEN %L
    ELSE NULL END', r, 'liability'));
    EXECUTE def;
  END IF;

  -- ledger_account_role_is_control is a different shape from role_type: one
  -- SQL SELECT with an IN (…) list. The role is added to that list by closing
  -- it one role later, which is why the anchor is the final ')' of the list.
  def := pg_get_functiondef('ledger_account_role_is_control(text)'::regprocedure);
  IF position(quote_literal(r) IN def) = 0 THEN
    IF position('''interproperty_clearing'')' IN def) = 0 THEN
      RAISE EXCEPTION 'ledger_account_role_is_control() no longer ends at interproperty_clearing; add % by hand', r;
    END IF;
    def := replace(def, '''interproperty_clearing'')',
                        format('''interproperty_clearing'', %L)', r));
    EXECUTE def;
  END IF;
END $role$;

DO $check$
BEGIN
  IF ledger_account_role_type('collected_for_another_operator') IS DISTINCT FROM 'liability' THEN
    RAISE EXCEPTION 'the passthrough-collection role did not reach the posting-role catalog';
  END IF;
  IF NOT ledger_account_role_is_control('collected_for_another_operator') THEN
    RAISE EXCEPTION 'the passthrough-collection role must be a control role (no hand entries)';
  END IF;
END $check$;
