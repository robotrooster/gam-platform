-- 10/12 (Nic) — GAM BOOKS LEDGER: BOOKKEEPER JOURNAL ENTRIES, READY FOR THE LEDGER
--
-- A bookkeeper's journal entry is the one hand-made posting in the ledger: the
-- automatic postings come from the money records, and the bookkeeper adds
-- adjusting entries on top (gam-ledger-design-2026-10-12 §1, §4, §11, §13, J4).
-- The entry stays exactly as entered in journal_entries / journal_entry_lines;
-- a later phase (P7) mirrors it into ledger_postings. Getting the entry tables
-- ready now:
--
-- journal_entry_lines
--   + property_id, unit_id, lease_id   every ledger line carries its property
--                                      (§9); a hand entry says which one
--   + debit/credit never negative (a negative credit is a debit in disguise;
--     routes/books.ts refuses one too, so this never fires on live input).
--     A line that carries both a debit and a credit is unusual but not wrong,
--     and the live journal route accepts it, so it is NOT refused here — the
--     P7 mirror books each side as its own ledger line. Production had 0
--     lines on 10/12; checked NOT VALID first and validated when nothing
--     breaks it.
--   + indexes on entry_id and account_id
--   + entry_id: ON DELETE CASCADE → RESTRICT. An entry is voided, never erased
--     (keep-everything); a delete of a posted entry may not take its lines with
--     it.
--   + a line may not post to an account a CONTROL posting role maps to
--     (receivables, money GAM holds, deposits owed, ...): those balances are
--     proven against the money records every night, so a hand line there would
--     make them disagree. The control roles are ledger_account_role_is_control()
--     (LEDGER_CONTROL_ROLES in packages/shared). An account that carried a
--     control role at any time stays control.
--
-- journal_entries
--   + adjusts_line_key   the automatic line an adjusting entry adjusts (P7)
--   + reverses_entry_id  the entry a reversing entry takes back
--   + voided_at, voided_by
--   + type CHECK: 'manual', 'adjusting', 'reversing' (BOOKS_JOURNAL_ENTRY_TYPES)
--   + CLOSED MONTHS: an entry dated on or before the company's lock
--     (ledger_closed_through()) is refused, and an entry may not be moved into
--     or out of a closed month (§13). Its lines are held the same way: a line
--     may not be added to, changed on or removed from an entry dated in a
--     closed month — the fix is a new entry dated after the close, which shows
--     as a correction. Closing is optional and the owner decides who may
--     (Nic, 10/12); while nothing is closed this never fires. Both take the
--     company's shared ledger lock first, so they cannot race a close.
--
-- Expand-only; safe to apply before the code ships.
-- No backfill needed (production had 0 journal entries on 10/12).
-- Safe drop: the new columns, CHECKs, indexes and the three guard triggers;
-- restore ON DELETE CASCADE on journal_entry_lines_entry_id_fkey.

SET LOCAL lock_timeout = '10s';

-- ── journal_entry_lines ─────────────────────────────────────────────────────

ALTER TABLE journal_entry_lines
  ADD COLUMN IF NOT EXISTS property_id uuid,
  ADD COLUMN IF NOT EXISTS unit_id     uuid,
  ADD COLUMN IF NOT EXISTS lease_id    uuid;

ALTER TABLE journal_entry_lines
  ADD CONSTRAINT journal_entry_lines_amounts_check
  CHECK (debit >= 0 AND credit >= 0) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journal_entry_lines WHERE NOT (debit >= 0 AND credit >= 0)) THEN
    ALTER TABLE journal_entry_lines VALIDATE CONSTRAINT journal_entry_lines_amounts_check;
  ELSE
    RAISE NOTICE 'journal_entry_lines_amounts_check left NOT VALID: some existing line has a negative amount';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS journal_entry_lines_entry ON journal_entry_lines (entry_id);
CREATE INDEX IF NOT EXISTS journal_entry_lines_account ON journal_entry_lines (account_id);

ALTER TABLE journal_entry_lines DROP CONSTRAINT IF EXISTS journal_entry_lines_entry_id_fkey;
ALTER TABLE journal_entry_lines
  ADD CONSTRAINT journal_entry_lines_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES journal_entries(id) NOT VALID;
ALTER TABLE journal_entry_lines VALIDATE CONSTRAINT journal_entry_lines_entry_id_fkey;

CREATE OR REPLACE FUNCTION journal_entry_lines_control_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  acct_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM books_account_map m
              WHERE m.account_id = NEW.account_id AND m.map_kind = 'role'
                AND ledger_account_role_is_control(m.map_value)) THEN
    SELECT name INTO acct_name FROM books_accounts WHERE id = NEW.account_id;
    RAISE EXCEPTION '% is kept by GAM from the money records, so it takes no journal lines. Post the adjustment to another account.', acct_name
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS journal_entry_lines_control_guard ON journal_entry_lines;
CREATE TRIGGER journal_entry_lines_control_guard
  BEFORE INSERT OR UPDATE OF account_id ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION journal_entry_lines_control_guard();

-- ── journal_entries ─────────────────────────────────────────────────────────

ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS adjusts_line_key  text,
  ADD COLUMN IF NOT EXISTS reverses_entry_id uuid REFERENCES journal_entries(id),
  ADD COLUMN IF NOT EXISTS voided_at         timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by         uuid REFERENCES users(id);

ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_type_check CHECK (type IN ('manual', 'adjusting', 'reversing')) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE type NOT IN ('manual', 'adjusting', 'reversing')) THEN
    ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_entries_type_check;
  ELSE
    RAISE NOTICE 'journal_entries_type_check left NOT VALID: some existing entry has another type';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION journal_entries_closed_period_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  locked_to date;
BEGIN
  IF NEW.landlord_id IS NULL AND NEW.business_id IS NULL THEN
    RETURN NEW;  -- an admin's ownerless entry has no company books to lock
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.date IS NOT DISTINCT FROM OLD.date THEN
    RETURN NEW;  -- the date was written back unchanged
  END IF;
  PERFORM pg_advisory_xact_lock_shared(ledger_owner_lock_key(NEW.landlord_id, NEW.business_id));
  locked_to := ledger_closed_through(NEW.landlord_id, NEW.business_id);
  IF locked_to IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.date <= locked_to THEN
    RAISE EXCEPTION 'The books are closed through %. Date the entry after that; it will show as a correction.', locked_to
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.date <= locked_to THEN
    RAISE EXCEPTION 'This entry is in a month closed through %; it cannot move out of it.', locked_to
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS journal_entries_closed_period_guard ON journal_entries;
CREATE TRIGGER journal_entries_closed_period_guard
  BEFORE INSERT OR UPDATE OF date ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_closed_period_guard();

-- A line on an entry dated in a closed month is never added, changed or removed.
CREATE OR REPLACE FUNCTION journal_entry_lines_closed_period_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  e         record;
  locked_to date;
BEGIN
  FOR e IN
    SELECT DISTINCT je.landlord_id, je.business_id, je.date
      FROM journal_entries je
     WHERE je.id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.entry_id END, CASE WHEN TG_OP <> 'DELETE' THEN NEW.entry_id END)
       AND (je.landlord_id IS NOT NULL OR je.business_id IS NOT NULL)
  LOOP
    PERFORM pg_advisory_xact_lock_shared(ledger_owner_lock_key(e.landlord_id, e.business_id));
    locked_to := ledger_closed_through(e.landlord_id, e.business_id);
    IF locked_to IS NOT NULL AND e.date <= locked_to THEN
      RAISE EXCEPTION 'This entry is in a month closed through %. Add a new entry dated after it; it will show as a correction.', locked_to
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

DROP TRIGGER IF EXISTS journal_entry_lines_closed_period_guard ON journal_entry_lines;
CREATE TRIGGER journal_entry_lines_closed_period_guard
  BEFORE INSERT OR UPDATE OR DELETE ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION journal_entry_lines_closed_period_guard();
