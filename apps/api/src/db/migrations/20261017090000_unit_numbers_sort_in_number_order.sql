-- 10/15 (Nic): "mobile home 3.5 shows up after mobile home 26. They need to
-- show up in true numerical order ... I don't know if that's because of a
-- decimal point or because it starts with a three and it's reading it as 35."
-- Both guesses were right in different places: every plain `ORDER BY
-- u.unit_number` sorted as TEXT ('26' < '3.5'), and the two places that pulled
-- the digits out stripped the dot ('MH 3.5' -> 35, after 26).
--
-- Fixed at the column, not at the call sites: there are 57 `ORDER BY ...
-- unit_number` in the API alone, and auditing them (and every one written
-- later) is the thing we do not do with units-wide rules. An ICU collation
-- with numeric ordering (en-u-kn-true) makes the SERVER sort digit runs as
-- numbers, so every one of those 57 — and the next one somebody writes —
-- comes out in number order: MH 2, MH 3, MH 3.5, MH 11, MH 26, and A-2b
-- before A-12b.
--
-- Set on every text column that holds a space's name, not just units:
-- Postgres refuses a comparison between two columns with different
-- collations, and `COALESCE(u.display_label, u.unit_number)` (the e-sign
-- property list) is exactly that. units.display_label and
-- unit_number_history.unit_number therefore move with it.
--
-- deterministic = true, so equality is unchanged (byte comparison): every
-- `unit_number = $1` lookup, the unique index on lower(btrim(unit_number)),
-- and the units triggers behave exactly as before. ALTER COLUMN TYPE rewrites
-- the table (120-odd rows per park) and rebuilds its indexes.
--
-- Safe drop: re-run the two ALTERs with `COLLATE pg_catalog."default"`.
-- No backfill: no stored value changes, only the order they come back in.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'unit_natural') THEN
    CREATE COLLATION public.unit_natural (provider = icu, locale = 'en-u-kn-true', deterministic = true);
  END IF;
END $$;

COMMENT ON COLLATION public.unit_natural IS
  '10/15 (Nic): space names sort in number order (MH 3.5 before MH 11), digit runs read as numbers.';

-- trg_unit_number_history_upd is declared AFTER UPDATE OF unit_number, so
-- Postgres refuses to alter the column while it exists ("cannot alter type of
-- a column used in a trigger definition"). It goes and comes back exactly as
-- pg_get_triggerdef prints it, in the same transaction as the alter, so the
-- rename journal is never without its trigger.
DROP TRIGGER IF EXISTS trg_unit_number_history_upd ON units;

ALTER TABLE units
  ALTER COLUMN unit_number   TYPE text COLLATE public.unit_natural,
  ALTER COLUMN display_label TYPE text COLLATE public.unit_natural;

CREATE TRIGGER trg_unit_number_history_upd
  AFTER UPDATE OF unit_number, building ON units
  FOR EACH ROW EXECUTE FUNCTION fn_unit_number_history();

ALTER TABLE unit_number_history
  ALTER COLUMN unit_number TYPE text COLLATE public.unit_natural;
