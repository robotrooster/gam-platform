-- 10/11 (Nic) — GAM BOOKS: EACH COMPANY NUMBERS ITS OWN JOURNAL ENTRIES
--
-- journal_entries.entry_number came from one sequence shared by every company
-- on GAM, so a company's first entry could be #4,512 and its numbers jumped
-- with every other company's posting — and the gaps told one company how busy
-- the others were. Each company (a landlord company or a business, the owner
-- of the row) now numbers its own entries 1, 2, 3, …
--
-- A BEFORE INSERT trigger assigns the number: the owner's highest number plus
-- one, under a per-owner transaction lock so two entries posted at the same
-- moment cannot take the same number. The unique index below backs it up. The
-- shared sequence is no longer the column default (it is left in place, unused).
--
-- Existing rows keep the numbers they have — numbers people may have written on
-- a check stub or a statement are not changed. They came from one global
-- sequence, so they are already unique within any company; a company's next
-- entry follows its own highest number. Production had 0 entries on 10/12.
--
-- Entries with no owner (made by a GAM admin) number among themselves and are
-- left out of the unique index (their key is NULL).
--
-- Backfill: none.
-- Safe drop: the trigger, its function and the index (then restore the default
-- nextval('journal_entries_entry_number_seq')).

CREATE OR REPLACE FUNCTION journal_entries_number_per_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'journal_entry_number:' || COALESCE(NEW.landlord_id::text, NEW.business_id::text, 'no-owner'), 0));
  SELECT COALESCE(max(je.entry_number), 0) + 1
    INTO NEW.entry_number
    FROM journal_entries je
   WHERE je.landlord_id IS NOT DISTINCT FROM NEW.landlord_id
     AND je.business_id IS NOT DISTINCT FROM NEW.business_id;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_entries_number_per_owner
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_number_per_owner();

ALTER TABLE journal_entries ALTER COLUMN entry_number DROP DEFAULT;

CREATE UNIQUE INDEX journal_entries_owner_number_key
  ON journal_entries ((COALESCE(landlord_id, business_id)), entry_number);
