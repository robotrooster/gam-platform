-- 10/27 — THE ARRANGEMENT KEEPS ITS HISTORY.
--
-- 20261028050000 created `left_owing_collections` and did not give it the
-- change journal. It holds three money columns (total_amount,
-- collected_amount, installment_amount) and `collected_amount` is written
-- every time an installment settles, so without this trigger there is no
-- record of what the arrangement said before a credit was applied — and the
-- GAM Books rebuild reads `audit_row_changes` to explain exactly that kind of
-- difference.
--
-- CLAUDE.md states the rule plainly: "Every table that holds money gets the
-- trigger in the migration that creates it." This is that trigger, late.
-- `services/ledgerSourceFacts.test.ts` is what caught it, which is the whole
-- reason that test exists.
--
-- This is about the JOURNAL, not the LEDGER. The arrangement is not a posting
-- source and is named in LEDGER_EXCLUDED_TABLES: writing the row moves no
-- money. The money moves when an installment rides the resident's rent as an
-- ordinary `payments` row (type='carried_balance'), and that row is captured
-- where every other payment is — so the dollar is counted once, where it
-- actually moved. Same shape as the `tenant_left_owing` exclusion beside it.
--
-- NO BACKFILL NEEDED: the journal records changes from here forward, and the
-- table has no rows yet (created and still unreached by any production path).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = to_regclass('public.left_owing_collections')
       AND tgname = 'audit_left_owing_collections'
  ) THEN
    CREATE TRIGGER audit_left_owing_collections
      AFTER DELETE OR UPDATE ON public.left_owing_collections
      FOR EACH ROW EXECUTE FUNCTION audit_row_change();
  END IF;
END $$;
