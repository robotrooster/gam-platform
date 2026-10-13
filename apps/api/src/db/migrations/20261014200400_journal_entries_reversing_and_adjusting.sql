-- 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P7: A BOOKKEEPER'S ADJUSTING AND REVERSING ENTRIES SAY WHAT THEY ADJUST
--
-- A bookkeeper's journal entry is the one hand-made posting in the ledger; it
-- mirrors into ledger_postings exactly as entered (design §6 J4,
-- services/ledgerProjectors/manualJournal). Migration 20261013200400 added the
-- two links an entry carries; this holds them to their meaning:
--
--   journal_entries.reverses_entry_id
--       only a REVERSING entry names one, and a reversing entry always does
--       (it takes back exactly that entry, sides swapped). An entry is taken
--       back by at most one live reversing entry: a second would take it back
--       twice. (A voided reversing entry no longer counts.)
--   journal_entries.adjusts_line_key
--       only an ADJUSTING entry names one: the automatic record it adjusts,
--       '<source type>:<source id>' (ledgerSourceKey in packages/shared — a
--       record, not one line: a posting's lines are re-made whenever its
--       record changes, the record stays). Optional: a month-end accrual
--       adjusts no one record.
--
-- And a voided entry says when (voided_at): the void route set only status
-- until 10/12. Entries voided before today get the moment they were last
-- changed (production had 0 journal entries on 10/12).
--
-- Expand-only; safe before the code ships: the live journal route writes
-- neither link and sets type 'manual' unless asked, so nothing it writes
-- breaks these.
-- Safe drop: the three CHECKs and the unique index.

SET LOCAL lock_timeout = '10s';

UPDATE journal_entries SET voided_at = COALESCE(updated_at, created_at, now())
 WHERE status = 'voided' AND voided_at IS NULL;

ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_reversing_names_entry
  CHECK ((type = 'reversing') = (reverses_entry_id IS NOT NULL)) NOT VALID;
ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_adjusting_key
  CHECK (adjusts_line_key IS NULL OR (type = 'adjusting' AND adjusts_line_key ~ '^[a-z_]+:[0-9A-Za-z._:|-]{1,200}$')) NOT VALID;
ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_not_its_own_reversal
  CHECK (reverses_entry_id IS NULL OR reverses_entry_id <> id) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE (type = 'reversing') <> (reverses_entry_id IS NOT NULL)) THEN
    ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_entries_reversing_names_entry;
  ELSE
    RAISE NOTICE 'journal_entries_reversing_names_entry left NOT VALID: an existing reversing entry names nothing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE adjusts_line_key IS NOT NULL) THEN
    ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_entries_adjusting_key;
  ELSE
    RAISE NOTICE 'journal_entries_adjusting_key left NOT VALID: entries already carry an adjusts_line_key';
  END IF;
  ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_entries_not_its_own_reversal;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_one_live_reversal
  ON journal_entries (reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL AND status <> 'voided' AND voided_at IS NULL;
