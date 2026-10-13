-- 10/12 (Nic) — A STORED FACT SAYS WHETHER IT WAS RECORDED OR WORKED OUT LATER
--
-- The ledger (gam-ledger-design-2026-10-12 §P1, M2) rebuilds every posting
-- from facts stored when the money moved: the split of each owner share, who
-- collected a deposit, when a receipt was undone, which property a held payout
-- line belongs to, the lodging tax inside a booking deposit, the tax a register
-- refund gave back, when a sale was voided. Each of those is now written by its
-- writer at the moment it happens (the files after this one).
--
-- Rows that existed before today get the same facts from an idempotent
-- backfill (scripts/oct12_ledger_source_facts_backfill.ts), worked out from
-- what is on record. A worked-out value is not the same as one recorded at the
-- time, and a rebuild, a report or a person checking the books must be able to
-- tell them apart. This table names every value the backfill worked out — one
-- row per (table, row, column), with how it was worked out and what it wrote.
-- A value with no row here was recorded by its writer.
--
-- column_name '*' marks a whole row the backfill wrote (an allocation_splits
-- row for an owner share booked before the table existed).
--
-- Insert-only, from the backfill (ON CONFLICT DO NOTHING keeps a re-run from
-- writing twice). Nothing reads it to move money.
--
-- No backfill needed (the backfill writes it).
-- Safe drop: DROP TABLE ledger_derived_facts.

CREATE TABLE IF NOT EXISTS ledger_derived_facts (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name   text NOT NULL,
  row_id       uuid NOT NULL,
  column_name  text NOT NULL,
  method       text NOT NULL,
  value        jsonb,
  derived_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_derived_facts_one_per_value UNIQUE (table_name, row_id, column_name)
);

COMMENT ON TABLE ledger_derived_facts IS
  '10/12 (Nic, ledger P1): every stored money fact the backfill WORKED OUT for a row that existed before its writer recorded it. No row here = recorded at the time by its writer.';
COMMENT ON COLUMN ledger_derived_facts.column_name IS
  'The column the backfill filled; ''*'' = the whole row (allocation_splits rows for owner shares booked before 10/12).';
COMMENT ON COLUMN ledger_derived_facts.method IS
  'How the value was worked out, in plain words (what it was read from).';
